import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createHandler } from './index';
import { assetMatcher, loadConfig, tokenSecretName } from './config';

const origin = 'https://proxy.example';
const published = '2026-10-07T01:00:00Z';

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

function fixtureProduct(repository: string) {
  return {
    repository,
    tagPattern: '^r[0-9]+$',
    assets: ['appcast.xml', 'app.zip', 'checksums.txt'],
    latest: { 'appcast.xml': 'appcast.xml', 'desktop.zip': 'app.zip' },
  };
}

const fixtures = {
  first: fixtureProduct('me/First'),
  second: {
    ...fixtureProduct('me/Second'),
    publicReleasePage: 'https://second.example/releases/{tag}',
  },
};
const env = {
  PRODUCTS: JSON.stringify(fixtures),
  PUBLIC_REPOSITORIES: 'jqlang/jq',
  FIRST_GITHUB_TOKEN: 'first-secret',
  SECOND_GITHUB_TOKEN: 'second-secret',
};

function fixtureFetch(callback?: (remote: Request) => Response | undefined): typeof fetch {
  return fetchMock((remote) => {
    const replaced = callback?.(remote);
    if (replaced) return replaced;
    const second = remote.url.includes('/Second/');
    const secret = second ? env.SECOND_GITHUB_TOKEN : env.FIRST_GITHUB_TOKEN;
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
    const worker = createHandler(fixtureFetch());
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
      fixtureFetch((remote) => {
        if (remote.url.includes('/First/')) {
          firstRequests += 1;
          return json({ message: env.FIRST_GITHUB_TOKEN }, 403);
        }
      }),
    );
    const missing = await worker.fetch(request('/first/releases/latest'), {
      PRODUCTS: env.PRODUCTS,
      SECOND_GITHUB_TOKEN: env.SECOND_GITHUB_TOKEN,
    });
    expect(missing.status).toBe(503);
    expect(firstRequests).toBe(0);
    const broken = await worker.fetch(request('/first/releases/latest'), env);
    expect(broken.status).toBe(502);
    expect(await broken.text()).not.toContain(env.FIRST_GITHUB_TOKEN);
    const working = await worker.fetch(request('/second/latest/desktop.zip'), env);
    expect(working.status).toBe(200);
    expect(await working.text()).toBe('second!!');
    expect(firstRequests).toBe(1);
  });

  it('必要 Release 信息只公开获准资产，并使用请求所在域名和登记的公开页面', async () => {
    const fetcher = fetchMock((remote) => {
      expect(remote.url).toBe('https://api.github.com/repos/me/Second/releases/latest');
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
    const response = await createHandler(fetcher).fetch(
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
          browser_download_url: 'https://caller.example/second/releases/download/r1/app.zip',
        },
      ],
      html_url: 'https://second.example/releases/r1',
    });
  });

  it('未登记公开页面时不公开私有 Release 的 html_url', async () => {
    const response = await createHandler(fixtureFetch()).fetch(
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
    const response = await createHandler(fetcher).fetch(request('/first/latest/appcast.xml'), env);
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
    const response = await createHandler(fetcher).fetch(request('/first/latest/desktop.zip'), env);
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
        expect(remote.headers.get('Authorization')).toBe(`Bearer ${env.FIRST_GITHUB_TOKEN}`);
        expect(remote.redirect).toBe('manual');
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://release-assets.githubusercontent.com/signed/file' },
        });
      }
      external = remote;
      return new Response('download');
    });
    const response = await createHandler(fetcher).fetch(request('/first/latest/desktop.zip'), env);
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
    const response = await createHandler(fetcher).fetch(request('/first/latest/desktop.zip'), env);
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
    const wrongTag = createHandler(fetchMock(() => json(release('r2', [asset(11, 'app.zip')]))));
    expect((await wrongTag.fetch(request('/first/releases/download/r1/app.zip'), env)).status).toBe(
      404,
    );
    const missing = createHandler(fetchMock(() => json(release('r1', []))));
    expect((await missing.fetch(request('/first/latest/desktop.zip'), env)).status).toBe(404);
  });

  it('GitHub 404、错误格式和连接故障保持失败关闭', async () => {
    const absent = createHandler(fetchMock(() => json({}, 404)));
    expect((await absent.fetch(request('/first/releases/latest'), env)).status).toBe(404);
    const malformed = createHandler(fetchMock(() => json({ private: env.FIRST_GITHUB_TOKEN })));
    const invalid = await malformed.fetch(request('/first/releases/latest'), env);
    expect(invalid.status).toBe(502);
    expect(await invalid.text()).not.toContain(env.FIRST_GITHUB_TOKEN);
    const unavailable = createHandler(
      fetchMock(() => {
        throw new Error(env.FIRST_GITHUB_TOKEN);
      }),
    );
    const failure = await unavailable.fetch(request('/first/releases/latest'), env);
    expect(failure.status).toBe(502);
    expect(await failure.text()).not.toContain(env.FIRST_GITHUB_TOKEN);
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
      const response = await createHandler(fetcher).fetch(
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
    const response = await createHandler(fetcher).fetch(
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
    expect((await createHandler(fetcher).fetch(request(path), env)).status).toBe(404);
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
    const response = await createHandler(fetcher).fetch(
      request('/github.com/jqlang/jq/releases/download/jq-1.8.1/jq-linux-amd64'),
      env,
    );
    expect(response.status).toBe(502);
    expect(requests).toBe(1);
  });
});

describe('环境配置与附件规则', () => {
  const sampleEnv = {
    PRODUCTS: {
      'my-app': {
        repository: 'me/MyApp',
        assets: ['MyApp_{version}_*.zip', 'MyApp-{version}-*.dmg', 'latest.json', 'SHA256SUMS.txt'],
        latest: { 'desktop.zip': 'MyApp_{version}_x64.zip', 'latest.json': 'latest.json' },
      },
    },
    MY_APP_GITHUB_TOKEN: 'sample-secret',
  };

  it.each(['v1.4.0', '1.4.0'])('{version} 与 * 匹配对应 tag 的版本化附件 %s', async (tag) => {
    const name = 'MyApp_1.4.0_x64.zip';
    const fetcher = fetchMock((remote) => {
      expect(remote.headers.get('Authorization')).toBe('Bearer sample-secret');
      if (remote.url === `https://api.github.com/repos/me/MyApp/releases/tags/${tag}`)
        return json(release(tag, [asset(53, name, name.length)]));
      if (remote.url.endsWith('/releases/assets/53')) return new Response(name);
      throw new Error(`Unexpected request ${remote.url}`);
    });
    const response = await createHandler(fetcher).fetch(
      request(`/my-app/releases/download/${tag}/${name}`),
      sampleEnv,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(name);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it.each([
    ['desktop.zip', 'MyApp_1.4.0_x64.zip'],
    ['latest.json', 'latest.json'],
  ])('最新版别名支持版本模板与固定清单 %s', async (alias, name) => {
    const fetcher = fetchMock((remote) =>
      remote.url.endsWith('/releases/latest')
        ? json(release('v1.4.0', [asset(52, name, name.length)]))
        : new Response(name),
    );
    const response = await createHandler(fetcher).fetch(
      request(`/my-app/latest/${alias}`),
      sampleEnv,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(name);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it.each([
    '/my-app/releases/download/v1.4.0/MyApp_1.5.0_x64.zip',
    '/my-app/releases/download/v1.4.0/MyApp_1x4x0_x64.zip',
    '/my-app/latest.json',
    '/my-app/MyApp_1.4.0_x64.zip',
  ])('另一版本文件和已移除的根目录路径不访问上游 %s', async (path) => {
    let requests = 0;
    const worker = createHandler(
      fetchMock(() => {
        requests += 1;
        return json({});
      }),
    );
    expect((await worker.fetch(request(path), sampleEnv)).status).toBe(404);
    expect(requests).toBe(0);
  });

  it('附件模式转义正则特殊字符、整串匹配且 * 不匹配斜线', () => {
    const matcher = assetMatcher('App.[x]+_{version}_*.zip', '1.4.0');
    expect(matcher.test('App.[x]+_1.4.0_x64.zip')).toBe(true);
    expect(matcher.test('App.[x]+_1.4.0_.zip')).toBe(true);
    for (const name of [
      'App.xxxx_1.4.0_x64.zip',
      'App.[x]+_1x4x0_x64.zip',
      'App.[x]+_1.4.0_dir/file.zip',
      'prefix-App.[x]+_1.4.0_x64.zip',
      'App.[x]+_1.4.0_x64.zip.bak',
    ]) {
      expect(matcher.test(name)).toBe(false);
    }
    expect(tokenSecretName('my-app')).toBe('MY_APP_GITHUB_TOKEN');
  });

  it.each([JSON.stringify(fixtures), fixtures])(
    'PRODUCTS 支持字符串和已解析对象',
    async (PRODUCTS) => {
      const response = await createHandler(fixtureFetch()).fetch(
        request('/first/releases/latest'),
        { ...env, PRODUCTS },
      );
      expect(response.status).toBe(200);
    },
  );

  it.each([
    'jqlang/jq, me/Other',
    'jqlang/jq\nme/Other',
    '["jqlang/jq", "me/Other"]',
    ['jqlang/jq', 'me/Other'],
  ])('PUBLIC_REPOSITORIES 支持文本和 JSON 数组 %j', (PUBLIC_REPOSITORIES) => {
    expect(loadConfig({ PUBLIC_REPOSITORIES }).publicRepositories).toEqual([
      'jqlang/jq',
      'me/Other',
    ]);
  });

  it.each([
    '{broken',
    [],
    null,
    { 'Bad-ID': fixtureProduct('me/First') },
    { first: { ...fixtures.first, repository: 'https://attacker.example/file' } },
    { first: { ...fixtures.first, assets: ['dir/file.zip'] } },
    { first: { ...fixtures.first, assets: 'app.zip' } },
    { first: { ...fixtures.first, latest: { 'desktop.zip': 42 } } },
    { first: { ...fixtures.first, latest: null } },
    { first: { ...fixtures.first, tagPattern: '[' } },
  ])('PRODUCTS 无效时返回 503、记录 config_invalid 且不访问上游 %j', async (PRODUCTS) => {
    let requests = 0;
    const log = vi.spyOn(console, 'error');
    try {
      const worker = createHandler(
        fetchMock(() => {
          requests += 1;
          return json({});
        }),
      );
      const response = await worker.fetch(request('/first/releases/latest'), { ...env, PRODUCTS });
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({
          event: 'config_invalid',
          variable: 'PRODUCTS',
          status: 503,
          message: 'Proxy configuration is invalid',
        }),
      );
      expect(requests).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it.each(['[broken', ['me/First', 42], {}, 'me/First/extra', 'https://github.com/me/First'])(
    '公开名单无效时返回 503 且不访问上游 %j',
    async (PUBLIC_REPOSITORIES) => {
      let requests = 0;
      const log = vi.spyOn(console, 'error');
      try {
        const worker = createHandler(
          fetchMock(() => {
            requests += 1;
            return json({});
          }),
        );
        const response = await worker.fetch(
          request('/github.com/jqlang/jq/releases/download/v1/app.zip'),
          { ...env, PUBLIC_REPOSITORIES },
        );
        expect(response.status).toBe(503);
        expect(log).toHaveBeenCalledWith(
          JSON.stringify({
            event: 'config_invalid',
            variable: 'PUBLIC_REPOSITORIES',
            status: 503,
            message: 'Proxy configuration is invalid',
          }),
        );
        expect(requests).toBe(0);
      } finally {
        log.mockRestore();
      }
    },
  );

  it('两类配置错误互不影响', async () => {
    const mirror = createHandler(
      fetchMock((remote) => {
        expect(remote.headers.has('Authorization')).toBe(false);
        return new Response('download');
      }),
    );
    expect(
      (
        await mirror.fetch(request('/github.com/jqlang/jq/releases/download/v1/app.zip'), {
          ...env,
          PRODUCTS: '{broken',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await createHandler(fixtureFetch()).fetch(request('/first/releases/latest'), {
          ...env,
          PUBLIC_REPOSITORIES: {},
        })
      ).status,
    ).toBe(200);
  });

  it('未配置时所有路径 404 且不访问上游', async () => {
    let requests = 0;
    const worker = createHandler(
      fetchMock(() => {
        requests += 1;
        return json({});
      }),
    );
    for (const path of [
      '/',
      '/first/releases/latest',
      '/github.com/jqlang/jq/releases/download/v1/app.zip',
    ]) {
      expect((await worker.fetch(request(path), {})).status).toBe(404);
    }
    expect(requests).toBe(0);
  });

  it('按原始值缓存解析结果，配置变化后重新读取', () => {
    const raw = JSON.stringify(fixtures);
    const first = loadConfig({ PRODUCTS: raw, PUBLIC_REPOSITORIES: 'jqlang/jq' });
    expect(loadConfig({ PRODUCTS: raw, PUBLIC_REPOSITORIES: 'jqlang/jq' }).products).toBe(
      first.products,
    );
    expect(loadConfig({ PRODUCTS: raw, PUBLIC_REPOSITORIES: 'jqlang/jq' }).publicRepositories).toBe(
      first.publicRepositories,
    );
    expect(loadConfig({ PRODUCTS: '{}' }).products).toEqual({});
    expect(loadConfig({ PRODUCTS: fixtures }).products).toHaveProperty('first');
  });

  it('上游异常日志遮蔽所有已配置产品的令牌', async () => {
    const log = vi.spyOn(console, 'error');
    try {
      const worker = createHandler(
        fetchMock(() => {
          throw new Error(`${env.FIRST_GITHUB_TOKEN} ${env.SECOND_GITHUB_TOKEN}`);
        }),
      );
      expect((await worker.fetch(request('/first/releases/latest'), env)).status).toBe(502);
      const output = JSON.stringify(log.mock.calls);
      expect(output).not.toContain(env.FIRST_GITHUB_TOKEN);
      expect(output).not.toContain(env.SECOND_GITHUB_TOKEN);
      expect(output).toContain('[redacted] [redacted]');
    } finally {
      log.mockRestore();
    }
  });

  it('部署配置不含部署者配置，保留变量、缓存与日志，并只使用不部署构建', () => {
    const config = JSON.parse(readFileSync('wrangler.json', 'utf8')) as {
      preview_urls: boolean;
      keep_vars: boolean;
      cache: { enabled: boolean };
      observability: { enabled: boolean };
    };
    expect(config).not.toHaveProperty('routes');
    expect(config).not.toHaveProperty('workers_dev');
    expect(config).not.toHaveProperty('secrets.required');
    expect(config.preview_urls).toBe(false);
    expect(config.keep_vars).toBe(true);
    expect(config.cache.enabled).toBe(true);
    expect(config.observability.enabled).toBe(true);
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
