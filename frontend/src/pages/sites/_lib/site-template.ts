export type SiteTemplate = 'standard' | 'simple';

/**
 * 按现网规范生成站点块。
 *
 * `standard` 抄的是 yueqixing-server 那份 Caddyfile 里每个站点都在用的那套：
 * 安全响应头（含删掉 Server / X-Powered-By）、gzip+zstd、JSON 访问日志、
 * 挡掉扫描器常打的路径、以及钉死 TLS 协议与套件。在这之前"可视化管理"只能生成
 * 一个光秃秃的 reverse_proxy，等于每次都得自己手抄一遍，抄漏了还不报错。
 */

/** 日志文件名用域名派生：api.example.com → api_example_com */
function slug(domain: string): string {
  return domain.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** 安全头 —— 先删掉两个会泄露实现的响应头，再补上安全策略。 */
const SECURITY_HEADERS = `    header {
        -Server
        -X-Powered-By
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
        X-XSS-Protection "1; mode=block"
        Content-Security-Policy "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "geolocation=(), microphone=(), camera=()"
    }`;

const BLOCKED_PATHS = `    # 挡掉扫描器常打的路径（.php / wp-admin / phpmyadmin 之类）
    @blockedPaths {
        path_regexp blockedPaths (?i)(\\.(php|asp|aspx|jsp|cgi|pl|py|exe|sh|bat)$|(wp-admin|wp-login|admin|administrator|phpmyadmin|setup|console))
    }
    respond @blockedPaths 403`;

const TLS = `    tls {
        protocols tls1.2 tls1.3
        curves x25519 secp256r1 secp384r1
        ciphers TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384 TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
    }`;

export function buildSiteBlock(opts: {
  domain: string;
  type: 'proxy' | 'static';
  target: string;
  template: SiteTemplate;
}): string {
  const { domain, type, target, template } = opts;

  if (template === 'simple') {
    return type === 'proxy'
      ? `${domain} {\n    reverse_proxy ${target}\n}`
      : `${domain} {\n    root * ${target}\n    file_server\n}`;
  }

  const serve =
    type === 'proxy'
      ? `    reverse_proxy ${target} {
        header_up X-Real-IP {remote_host}
        header_up CF-Connecting-IP {http.request.header.CF-Connecting-IP}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }`
      : `    root * ${target}
    file_server`;

  return `${domain} {
${serve}

${SECURITY_HEADERS}

    encode gzip zstd

    log {
        output file /var/log/caddy/${slug(domain)}_access.log
        format json
        level INFO
    }

${BLOCKED_PATHS}

${TLS}
}`;
}
