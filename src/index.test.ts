import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createHandler } from './index';
import { products } from './products';
import type { Product, ProductRegistry } from './products';

const origin = 'https://updates.ahua.space';
const published = '2026-10-07T01:00:00Z';
const env = { FIRST_TOKEN: 'first-secret', SECOND_TOKEN: 'second-secret' };

function asset(id: number, name: string, size = 8) {
  return { id, name, size, state: 'uploaded' };
}

function release(
  tag: string,
  assets: ReturnType<typeof asset>[],
  overrides: Record<string, unknown> = {},
) {
  return {
    tag_name: tag,
    published_at: published,
    draft: false,
    prerelease: false,
    assets,
    ...overrides,
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function request(path: string, method = 'GET') {
  return new Request(`${origin}${path}`, { method });
}

function fetchMock(callback: (request: Request) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => callback(new Request(input, init));
}

function fixtureProduct(repository: string, tokenSecret: string): Product {
  return {
    repository,
    tokenSecret,
    tagPattern: /^r[0-9]+$/,
    latestFiles: { 'appcast.xml': 'appcast.xml' },
    latestAliases: { 'desktop.zip': () => 'app.zip' },
    isAllowedAsset: (_tag, name) => ['appcast.xml', 'app.zip', 'checksums.txt'].includes(name),
  };
}

const fixtures: ProductRegistry = {
  first: fixtureProduct('Ahua9527/First', 'FIRST_TOKEN'),
  second: {
    ...fixtureProduct('Ahua9527/Second', 'SECOND_TOKEN'),
    publicReleasePage: 'https://second.example/releases/{tag}',
  },
};

function fixtureFetch(callback?: (remote: Request) => Response | undefined): typeof fetch {
  return fetchMock((remote) => {
    const replaced = callback?.(remote);
    if (replaced) return replaced;
    const second = remote.url.includes('/Second/');
    const secret = second ? env.SECOND_TOKEN : env.FIRST_TOKEN;
    expect(remote.headers.get('Authorization')).toBe(`Bearer ${secret}`);
    expect(remote.headers.get('User-Agent')).toBe('ReleaseProxy');
    if (remote.url.endsWith('/releases/latest') || remote.url.endsWith('/releases/tags/r1')) {
      const id = second ? 22 : 11;
      return json(
        release('r1', [asset(id, 'app.zip')], {
          body: 'private release notes',
          html_url: 'https://github.com/private/release',
          tarball_url: 'https://github.com/private/source.tar.gz',
          author: { login: 'private-author' },
        }),
      );
    }
    if (remote.url.endsWith(`/releases/assets/${second ? 22 : 11}`)) {
      return new Response(second ? 'second!!' : 'first!!!');
    }
    throw new Error(`Unexpected upstream request: ${remote.url}`);
  });
}

describe('多产品 ReleaseProxy', () => {
  it('同名资产按产品仓库和独立令牌读取', async () => {
    const worker = createHandler(fixtures, fixtureFetch());
    for (const [id, expected] of [
      ['first', 'first!!!'],
      ['second', 'second!!'],
    ]) {
      const response = await worker.fetch(request(`/${id}/releases/download/r1/app.zip`), env);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(expected);
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    }
  });

  it('某产品缺少或失效令牌时，其他产品仍可下载', async () => {
    let firstRequests = 0;
    const worker = createHandler(
      fixtures,
      fixtureFetch((remote) => {
        if (remote.url.includes('/First/')) {
          firstRequests += 1;
          return json({ message: env.FIRST_TOKEN }, 403);
        }
      }),
    );
    const missing = await worker.fetch(request('/first/releases/latest'), {
      SECOND_TOKEN: env.SECOND_TOKEN,
    });
    expect(missing.status).toBe(503);
    expect(firstRequests).toBe(0);
    const broken = await worker.fetch(request('/first/releases/latest'), env);
    expect(broken.status).toBe(502);
    expect(await broken.text()).not.toContain(env.FIRST_TOKEN);
    const working = await worker.fetch(request('/second/latest/desktop.zip'), env);
    expect(working.status).toBe(200);
    expect(await working.text()).toBe('second!!');
    expect(firstRequests).toBe(1);
  });

  it('必要 Release 信息只公开获准资产，并使用固定服务地址和登记的公开页面', async () => {
    const fetcher = fetchMock((remote) => {
      expect(remote.url).toBe('https://api.github.com/repos/Ahua9527/Second/releases/latest');
      return json(
        release('r1', [asset(22, 'app.zip'), asset(23, 'private-notes.md')], {
          body: 'private release notes',
          html_url: 'https://github.com/private/release',
          zipball_url: 'https://github.com/private/source.zip',
          target_commitish: 'private-commit',
          author: { login: 'private-author' },
        }),
      );
    });
    const response = await createHandler(fixtures, fetcher).fetch(
      new Request('https://caller.example/second/releases/latest'),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(await response.json()).toEqual({
      tag_name: 'r1',
      published_at: published,
      draft: false,
      prerelease: false,
      assets: [
        {
          name: 'app.zip',
          size: 8,
          browser_download_url: `${origin}/second/releases/download/r1/app.zip`,
        },
      ],
      html_url: 'https://second.example/releases/r1',
    });
  });

  it('未登记公开页面时不公开私有 Release 的 html_url', async () => {
    const response = await createHandler(fixtures, fixtureFetch()).fetch(
      request('/first/releases/latest'),
      env,
    );
    const body: unknown = await response.json();
    expect(body).not.toHaveProperty('html_url');
    expect(JSON.stringify(body)).not.toContain('private');
  });

  it('原生更新清单保持原字节，并使用短缓存', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x20, 0x3c, 0x78, 0x2f, 0x3e, 0x0a]);
    const fetcher = fetchMock((remote) =>
      remote.url.endsWith('/releases/latest')
        ? json(release('r1', [asset(31, 'appcast.xml', bytes.length)]))
        : new Response(bytes),
    );
    const response = await createHandler(fixtures, fetcher).fetch(
      request('/first/appcast.xml'),
      env,
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('文件响应直接转发流，不等待整个资产读完', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
    });
    const fetcher = fetchMock((remote) =>
      remote.url.endsWith('/releases/latest')
        ? json(release('r1', [asset(32, 'app.zip', 2)]))
        : new Response(stream),
    );
    const response = await createHandler(fixtures, fetcher).fetch(
      request('/first/latest/desktop.zip'),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe(stream);
    await response.body?.cancel();
  });

  it('处理 302 时不向临时下载地址转发任一产品令牌', async () => {
    let external: Request | undefined;
    const fetcher = fetchMock((remote) => {
      if (remote.url.endsWith('/releases/latest'))
        return json(release('r1', [asset(41, 'app.zip')]));
      if (remote.url.endsWith('/releases/assets/41')) {
        expect(remote.headers.get('Authorization')).toBe(`Bearer ${env.FIRST_TOKEN}`);
        expect(remote.redirect).toBe('manual');
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://release-assets.githubusercontent.com/signed/file' },
        });
      }
      external = remote;
      return new Response('download');
    });
    const response = await createHandler(fixtures, fetcher).fetch(
      request('/first/latest/desktop.zip'),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('download');
    expect(external?.url).toBe('https://release-assets.githubusercontent.com/signed/file');
    expect(external?.headers.has('Authorization')).toBe(false);
  });

  it.each([
    'https://attacker.example/file',
    'http://release-assets.githubusercontent.com/file',
    '/relative/file',
    'https://user:password@release-assets.githubusercontent.com/file',
  ])('拒绝异常的临时下载地址 %s', async (location) => {
    let requests = 0;
    const fetcher = fetchMock((remote) => {
      requests += 1;
      if (remote.url.endsWith('/releases/latest'))
        return json(release('r1', [asset(41, 'app.zip')]));
      return new Response(null, { status: 302, headers: { Location: location } });
    });
    const response = await createHandler(fixtures, fetcher).fetch(
      request('/first/latest/desktop.zip'),
      env,
    );
    expect(response.status).toBe(502);
    expect(requests).toBe(2);
  });

  it.each([
    '/unknown/releases/latest',
    '/constructor/releases/latest',
    '/__proto__/releases/latest',
    '/first/latest/constructor',
    '/first/latest/__proto__',
    '/first/README.md',
    '/first/%2f..%2fprivate',
    '/first/releases/download/r1/private-notes.md',
    '/first/releases/download/v1/app.zip',
    '/first/releases/download/r1/source.zip',
    '/first/releases/download/r1/asset%2fname',
  ])('未知或越界路径不访问 GitHub %s', async (path) => {
    let requests = 0;
    const worker = createHandler(
      fixtures,
      fetchMock(() => {
        requests += 1;
        return json({});
      }),
    );
    expect((await worker.fetch(request(path), env)).status).toBe(404);
    expect(requests).toBe(0);
  });

  it('非 GET 请求不访问上游', async () => {
    let requests = 0;
    const worker = createHandler(
      fixtures,
      fetchMock(() => {
        requests += 1;
        return json({});
      }),
    );
    const response = await worker.fetch(request('/first/releases/latest', 'POST'), env);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(requests).toBe(0);
  });

  it.each([{ draft: true }, { prerelease: true }, { tag_name: 'unexpected' }])(
    '排除不匹配的稳定 Release %j',
    async (flags) => {
      let requests = 0;
      const worker = createHandler(
        fixtures,
        fetchMock(() => {
          requests += 1;
          return json(release('r1', [asset(11, 'app.zip')], flags));
        }),
      );
      const response = await worker.fetch(request('/first/latest/desktop.zip'), env);
      expect(response.status).toBe(404);
      expect(requests).toBe(1);
    },
  );

  it('历史资产要求上游返回对应 tag，资产缺失时拒绝下载', async () => {
    const wrongTag = createHandler(
      fixtures,
      fetchMock(() => json(release('r2', [asset(11, 'app.zip')]))),
    );
    expect((await wrongTag.fetch(request('/first/releases/download/r1/app.zip'), env)).status).toBe(
      404,
    );
    const missing = createHandler(
      fixtures,
      fetchMock(() => json(release('r1', []))),
    );
    expect((await missing.fetch(request('/first/latest/desktop.zip'), env)).status).toBe(404);
  });

  it('GitHub 404、错误格式和连接故障保持失败关闭', async () => {
    const absent = createHandler(
      fixtures,
      fetchMock(() => json({}, 404)),
    );
    expect((await absent.fetch(request('/first/releases/latest'), env)).status).toBe(404);
    const malformed = createHandler(
      fixtures,
      fetchMock(() => json({ private: env.FIRST_TOKEN })),
    );
    const invalid = await malformed.fetch(request('/first/releases/latest'), env);
    expect(invalid.status).toBe(502);
    expect(await invalid.text()).not.toContain(env.FIRST_TOKEN);
    const unavailable = createHandler(
      fixtures,
      fetchMock(() => {
        throw new Error(env.FIRST_TOKEN);
      }),
    );
    const failure = await unavailable.fetch(request('/first/releases/latest'), env);
    expect(failure.status).toBe(502);
    expect(await failure.text()).not.toContain(env.FIRST_TOKEN);
    expect(failure.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('公开仓库 Release 附件加速', () => {
  it.each(['https://', 'https:/', ''])(
    '%s 前缀匿名下载登记仓库，并使用 7 天缓存',
    async (prefix) => {
      const urls: string[] = [];
      const fetcher = fetchMock((remote) => {
        urls.push(remote.url);
        expect(remote.headers.has('Authorization')).toBe(false);
        expect(remote.headers.get('User-Agent')).toBe('ReleaseProxy');
        expect(remote.redirect).toBe('manual');
        if (
          remote.url === 'https://github.com/jqlang/jq/releases/download/jq-1.8.1/jq-linux-amd64'
        ) {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://release-assets.githubusercontent.com/signed/file' },
          });
        }
        return new Response('download', { headers: { 'Content-Length': '8' } });
      });
      const response = await createHandler(fixtures, fetcher).fetch(
        request(`/${prefix}github.com/JQLANG/JQ/releases/download/jq-1.8.1/jq-linux-amd64`),
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('download');
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=604800');
      expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(response.headers.get('Content-Length')).toBe('8');
      expect(response.headers.get('Content-Disposition')).toBe(
        "attachment; filename*=UTF-8''jq-linux-amd64",
      );
      expect(urls).toEqual([
        'https://github.com/jqlang/jq/releases/download/jq-1.8.1/jq-linux-amd64',
        'https://release-assets.githubusercontent.com/signed/file',
      ]);
    },
  );

  it('latest 跟随版本地址和资产地址的两次跳转，并使用 5 分钟缓存', async () => {
    const urls: string[] = [];
    const fetcher = fetchMock((remote) => {
      urls.push(remote.url);
      expect(remote.headers.has('Authorization')).toBe(false);
      expect(remote.redirect).toBe('manual');
      if (remote.url === 'https://github.com/jqlang/jq/releases/latest/download/jq-linux-amd64') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: 'https://github.com/jqlang/jq/releases/download/jq-1.8.1/jq-linux-amd64',
          },
        });
      }
      if (remote.url === 'https://github.com/jqlang/jq/releases/download/jq-1.8.1/jq-linux-amd64') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://release-assets.githubusercontent.com/signed/file' },
        });
      }
      return new Response('download');
    });
    const response = await createHandler(fixtures, fetcher).fetch(
      request('/https://github.com/jqlang/jq/releases/latest/download/jq-linux-amd64'),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('download');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(urls).toEqual([
      'https://github.com/jqlang/jq/releases/latest/download/jq-linux-amd64',
      'https://github.com/jqlang/jq/releases/download/jq-1.8.1/jq-linux-amd64',
      'https://release-assets.githubusercontent.com/signed/file',
    ]);
  });

  it.each([
    '/https://github.com/unregistered/repo/releases/download/v1/file.zip',
    '/https://github.com/jqlang/jq/archive/refs/tags/jq-1.8.1.tar.gz',
    '/https://github.com/jqlang/jq/blob/main/README.md',
    '/https://github.com/jqlang/jq/releases.atom',
    '/https://api.github.com/repos/jqlang/jq/releases',
  ])('未登记或非 Release 附件路径不访问上游 %s', async (path) => {
    let requests = 0;
    const fetcher = fetchMock(() => {
      requests += 1;
      return new Response('unexpected');
    });
    expect((await createHandler(fixtures, fetcher).fetch(request(path), env)).status).toBe(404);
    expect(requests).toBe(0);
  });

  it.each([
    'https://attacker.example/file',
    'http://github.com/jqlang/jq/releases/download/jq-1.8.1/jq-linux-amd64',
    'https://github.com/evil/repo/releases/download/jq-1.8.1/jq-linux-amd64',
  ])('拒绝不允许的公开下载跳转 %s', async (location) => {
    let requests = 0;
    const fetcher = fetchMock(() => {
      requests += 1;
      return new Response(null, { status: 302, headers: { Location: location } });
    });
    const response = await createHandler(fixtures, fetcher).fetch(
      request('/github.com/jqlang/jq/releases/download/jq-1.8.1/jq-linux-amd64'),
      env,
    );
    expect(response.status).toBe(502);
    expect(requests).toBe(1);
  });
});

describe('IPG Scope 原有更新地址', () => {
  const tokenEnv = { IPG_SCOPE_RELEASES_READ_TOKEN: 'ipg-token' };
  const repository = 'https://api.github.com/repos/Ahua9527/IPG-Scope';

  it.each(['darwin-universal', 'windows-amd64', 'windows-arm64'])(
    '保留 %s 清单目录',
    async (target) => {
      const name = `update-${target}.json`;
      const body = `{"target":"${target}"}\n`;
      const fetcher = fetchMock((remote) => {
        expect(remote.headers.get('Authorization')).toBe('Bearer ipg-token');
        if (remote.url === `${repository}/releases/latest`)
          return json(release('v1.4.0', [asset(51, name, body.length)]));
        return new Response(body);
      });
      const response = await createHandler(products, fetcher).fetch(
        request(`/ipg-scope/${name}`),
        tokenEnv,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
    },
  );

  it.each([
    ['macos-universal.dmg', 'IPG.Scope-1.4.0-darwin-universal.dmg'],
    ['windows-amd64.exe', 'IPG.Scope.Setup-1.4.0-windows-amd64.exe'],
    ['windows-arm64.exe', 'IPG.Scope.Setup-1.4.0-windows-arm64.exe'],
  ])('保留安装包别名 %s', async (alias, name) => {
    const fetcher = fetchMock((remote) =>
      remote.url.endsWith('/releases/latest')
        ? json(release('v1.4.0', [asset(52, name, name.length)]))
        : new Response(name),
    );
    const response = await createHandler(products, fetcher).fetch(
      request(`/ipg-scope/latest/${alias}`),
      tokenEnv,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(name);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it.each(['ipg-scope-1.4.0-windows-amd64.tar.gz', 'ipg-scope-1.3.0-to-1.4.0-windows-arm64.delta'])(
    '保留版本化更新文件 %s',
    async (name) => {
      const fetcher = fetchMock((remote) => {
        if (remote.url === `${repository}/releases/tags/v1.4.0`)
          return json(release('v1.4.0', [asset(53, name, name.length)]));
        if (remote.url.endsWith('/releases/assets/53')) return new Response(name);
        throw new Error(`Unexpected request ${remote.url}`);
      });
      const response = await createHandler(products, fetcher).fetch(
        request(`/ipg-scope/${name}`),
        tokenEnv,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(name);
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    },
  );

  it('禁止把另一个版本的更新文件挂到当前 tag 下载', async () => {
    let requests = 0;
    const worker = createHandler(
      products,
      fetchMock(() => {
        requests += 1;
        return json({});
      }),
    );
    const response = await worker.fetch(
      request('/ipg-scope/releases/download/v1.4.0/ipg-scope-1.5.0-windows-amd64.tar.gz'),
      tokenEnv,
    );
    expect(response.status).toBe(404);
    expect(requests).toBe(0);
  });

  it('部署配置匹配产品 Secret，关闭其他公开入口，并只使用不部署构建', () => {
    const config = JSON.parse(readFileSync('wrangler.json', 'utf8')) as {
      workers_dev: boolean;
      preview_urls: boolean;
      routes: { pattern: string; custom_domain: boolean }[];
      cache: { enabled: boolean };
      secrets: { required: string[] };
    };
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toEqual([{ pattern: 'updates.ahua.space', custom_domain: true }]);
    // Release 信息用例已断言 browser_download_url 以 origin 开头，此处把它与部署域名绑定。
    expect(origin).toBe(`https://${config.routes[0]?.pattern}`);
    expect(config.cache.enabled).toBe(true);
    expect(config.secrets.required).toEqual(
      Object.values(products).map((product) => product.tokenSecret),
    );
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      packageManager: string;
      scripts: { build: string };
      devDependencies: { wrangler: string };
    };
    expect(pkg.packageManager).toBe(`bun@${readFileSync('.bun-version', 'utf8').trim()}`);
    expect(pkg.scripts.build).toContain('--dry-run');
    expect(pkg.devDependencies.wrangler).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('Worker 入口只导出函数和默认处理器，否则运行时拒绝启动', async () => {
    for (const [name, value] of Object.entries(await import('./index'))) {
      if (name !== 'default') expect(typeof value, name).toBe('function');
    }
  });
});
