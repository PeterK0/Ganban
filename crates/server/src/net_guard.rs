//! The SSRF guard: one place that decides whether the host may open a
//! connection to an address someone else chose (a model, a member, a feed URL).
//!
//! Blocked: loopback, private and link-local ranges, the CGNAT range
//! `100.64.0.0/10` (which is where a tailnet lives), IPv6 unique-local
//! `fc00::/7` (the tailnet's IPv6 range sits inside it), and the IPv6 forms that
//! embed an IPv4 address (mapped, compatible, NAT64, 6to4), judged by the
//! address they embed.
//!
//! Pinning: a name is resolved once, the addresses are checked, and those same
//! addresses are the ones connected to. For raw sockets that's
//! [`resolve_public`] followed by a connect to its result; for HTTP it's
//! [`client_builder`], whose resolver runs the check at connect time, so a DNS
//! rebind between a check and the connect has nothing to swap.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

/// The refusal every guarded path shows.
pub const BLOCKED: &str = "destination is not allowed (private/internal address)";

/// Whether an address is private or internal and must not be reached.
pub fn ip_is_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4_blocked(v4),
        IpAddr::V6(v6) => v6_blocked(v6),
    }
}

fn v4_blocked(v4: Ipv4Addr) -> bool {
    let o = v4.octets();
    v4.is_private()
        || v4.is_loopback()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_broadcast()
        || v4.is_documentation()
        || v4.is_multicast()
        || o[0] == 0
        || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10: CGNAT, the tailnet
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24: IETF protocol assignments
        || (o[0] == 198 && (o[1] & 0xfe) == 18) // 198.18.0.0/15: benchmarking
        || o[0] >= 240 // 240.0.0.0/4: reserved
}

fn v6_blocked(v6: Ipv6Addr) -> bool {
    let s = v6.segments();
    // IPv6 forms that carry an IPv4 address are judged by that address.
    let embedded = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if let Some(v4) = v6.to_ipv4_mapped() {
        return v4_blocked(v4); // ::ffff:a.b.c.d
    }
    if s[..6] == [0; 6] && !(s[6] == 0 && s[7] <= 1) {
        return v4_blocked(embedded(s[6], s[7])); // ::a.b.c.d (deprecated compatible form)
    }
    if s[..6] == [0, 0, 0, 0, 0xffff, 0] {
        return v4_blocked(embedded(s[6], s[7])); // ::ffff:0:a.b.c.d (IPv4-translated)
    }
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return v4_blocked(embedded(s[6], s[7])); // 64:ff9b::/96 NAT64
    }
    if s[0] == 0x2002 {
        return v4_blocked(embedded(s[1], s[2])); // 2002::/16 6to4
    }
    v6.is_loopback()
        || v6.is_unspecified()
        || v6.is_multicast()
        || (s[0] & 0xfe00) == 0xfc00 // unique-local fc00::/7 (the tailnet's fd7a:115c:a1e0::/48 too)
        || (s[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        || (s[0] & 0xffc0) == 0xfec0 // site-local fec0::/10 (deprecated, still routed on some LANs)
        || (s[0] == 0x64 && s[1] == 0xff9b && s[2] == 1) // 64:ff9b:1::/48 local-use NAT64
        || (s[0] == 0x2001 && s[1] == 0) // 2001::/32 Teredo
        || (s[0] == 0x2001 && s[1] == 0xdb8) // 2001:db8::/32 documentation
        || (s[0] == 0x100 && s[1..4] == [0, 0, 0]) // 100::/64 discard
}

/// Which destinations a connection may reach.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// Public addresses only: for anything a model, a member or a template
    /// can supply.
    PublicOnly,
    /// The owner's own network too (LAN, tailnet, this machine): for
    /// destinations only the owner can enter, such as a calendar subscription
    /// on a home Nextcloud. Cloud metadata endpoints stay blocked, since no
    /// owner means to subscribe to one and they hand out credentials.
    OwnerNetwork,
}

impl Scope {
    pub fn blocks(self, ip: IpAddr) -> bool {
        match self {
            Scope::PublicOnly => ip_is_blocked(ip),
            Scope::OwnerNetwork => is_metadata_endpoint(ip),
        }
    }
}

/// Cloud instance-metadata addresses: all of link-local `169.254.0.0/16` (AWS,
/// GCP, Azure, OpenStack, ECS task metadata), Alibaba's `100.100.100.200`,
/// AWS's IPv6 `fd00:ec2::254`, and IPv6 link-local. IPv6 forms that embed an
/// IPv4 address are judged by it.
pub fn is_metadata_endpoint(ip: IpAddr) -> bool {
    let v4 = |v4: Ipv4Addr| v4.is_link_local() || v4.octets() == [100, 100, 100, 200];
    match ip {
        IpAddr::V4(a) => v4(a),
        IpAddr::V6(a) => {
            let s = a.segments();
            if let Some(m) = a.to_ipv4_mapped() {
                return v4(m);
            }
            if s[..6] == [0; 6] || s[..6] == [0, 0, 0, 0, 0xffff, 0] || s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                return v4(Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8));
            }
            (s[0] & 0xffc0) == 0xfe80 || s == [0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254]
        }
    }
}

/// Resolve `host` and return its addresses, refusing the lot if any of them is
/// blocked. Connect to what this returns (not to the name again), so the
/// checked address is the one used.
pub async fn resolve_public(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    resolve(host, port, Scope::PublicOnly).await
}

/// [`resolve_public`] for a given [`Scope`].
pub async fn resolve(host: &str, port: u16, scope: Scope) -> Result<Vec<SocketAddr>, String> {
    let bare = host.trim().trim_start_matches('[').trim_end_matches(']');
    if bare.is_empty() {
        return Err("no host given".into());
    }
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return if scope.blocks(ip) { Err(BLOCKED.into()) } else { Ok(vec![SocketAddr::new(ip, port)]) };
    }
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((bare, port))
        .await
        .map_err(|e| format!("DNS lookup failed: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err("host did not resolve".into());
    }
    if addrs.iter().any(|a| scope.blocks(a.ip())) {
        return Err(BLOCKED.into());
    }
    Ok(addrs)
}

/// Check a URL before a request: http(s) only, and its host must resolve to
/// public addresses. The guarded client's resolver is what enforces the guard
/// (it resolves again at connect, and that answer is the one used); this gives
/// the clear message, and covers literal IPs, which skip the resolver.
pub async fn check_url(url: &reqwest::Url) -> Result<(), String> {
    check_url_in(url, Scope::PublicOnly).await
}

/// [`check_url`] for a given [`Scope`].
pub async fn check_url_in(url: &reqwest::Url, scope: Scope) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http(s) URLs can be fetched".into());
    }
    let host = url.host_str().ok_or("url has no host")?;
    let port = url.port_or_known_default().unwrap_or(443);
    resolve(host, port, scope).await.map(|_| ())
}

/// A URL whose host is a literal IP that's blocked (or that isn't http(s)). The
/// resolver never sees literal IPs, so redirects are checked with this.
fn url_is_refused_literal(url: &reqwest::Url, scope: Scope) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return true;
    }
    match url.host_str() {
        Some(h) => h.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>().map(|ip| scope.blocks(ip)).unwrap_or(false),
        None => true,
    }
}

/// Resolves names for the guarded client, refusing blocked addresses. reqwest
/// connects to exactly what this returns, which is what pins the address.
struct GuardedResolver(Scope);

impl reqwest::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        let scope = self.0;
        Box::pin(async move {
            let addrs = resolve(&host, 0, scope).await.map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// A client builder for requests to addresses someone else chose. Names go
/// through the guarded resolver, redirects are capped at `max_redirects` and
/// refused when they point at a blocked literal IP, and system proxies are
/// ignored (a proxy would make the connection on our behalf, out of the
/// guard's sight). Callers still run [`check_url`] on the first URL.
pub fn client_builder(max_redirects: usize) -> reqwest::ClientBuilder {
    client_builder_in(Scope::PublicOnly, max_redirects)
}

/// [`client_builder`] for a given [`Scope`]; pair it with [`check_url_in`].
pub fn client_builder_in(scope: Scope, max_redirects: usize) -> reqwest::ClientBuilder {
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() > max_redirects {
            attempt.error("too many redirects")
        } else if url_is_refused_literal(attempt.url(), scope) {
            attempt.error(BLOCKED)
        } else {
            attempt.follow()
        }
    });
    reqwest::Client::builder().dns_resolver(Arc::new(GuardedResolver(scope))).no_proxy().redirect(policy)
}

/// An HTTP error's text without its URL. Request URLs can carry keys (a query
/// parameter), and error text travels to logs, models and members.
pub fn error_text(e: reqwest::Error) -> String {
    e.without_url().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_internal_ranges_and_the_tailnet() {
        let blocked = [
            "127.0.0.1", "10.0.0.5", "172.16.3.4", "192.168.1.1", "169.254.169.254", "0.0.0.0", "255.255.255.255",
            "100.64.0.1", "100.100.100.100", "100.127.255.254", "198.18.0.1", "240.0.0.1", "224.0.0.1",
            "::1", "::", "fc00::1", "fd7a:115c:a1e0::1", "fe80::1", "fec0::1", "ff02::1",
            "::ffff:127.0.0.1", "::ffff:100.64.0.1", "::ffff:10.0.0.1", "::10.0.0.1", "64:ff9b::a00:1",
            "64:ff9b:1::1", "2002:c0a8:101::1", "::ffff:0:7f00:1", "2001:0:4136:e378::1", "2001:db8::1",
        ];
        for s in blocked {
            assert!(ip_is_blocked(s.parse::<IpAddr>().unwrap()), "{s} must be blocked (SSRF)");
        }
        let public = [
            "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.1", "2606:2800:220:1:248:1893:25c8:1946",
            "::ffff:1.1.1.1", "64:ff9b::101:101", "2002:101:101::1",
        ];
        for s in public {
            assert!(!ip_is_blocked(s.parse::<IpAddr>().unwrap()), "{s} is public");
        }
    }

    #[tokio::test]
    async fn resolve_public_refuses_names_and_literals_that_land_inside() {
        assert_eq!(resolve_public("localhost", 993).await.unwrap_err(), BLOCKED);
        assert_eq!(resolve_public("127.0.0.1", 993).await.unwrap_err(), BLOCKED);
        assert_eq!(resolve_public("[::1]", 993).await.unwrap_err(), BLOCKED);
        assert_eq!(resolve_public("100.101.102.103", 993).await.unwrap_err(), BLOCKED);
        let ok = resolve_public("1.1.1.1", 993).await.unwrap();
        assert_eq!(ok, vec!["1.1.1.1:993".parse::<SocketAddr>().unwrap()], "a literal is pinned as given");
    }

    #[tokio::test]
    async fn check_url_refuses_internal_and_non_http() {
        for u in [
            "http://127.0.0.1:8765/", "http://localhost/", "http://localhost./", "http://2130706433/", "http://[::1]/",
            "http://100.64.1.2/", "file:///etc/passwd",
        ] {
            assert!(check_url(&reqwest::Url::parse(u).unwrap()).await.is_err(), "{u} must be refused");
        }
    }

    #[test]
    fn redirect_literal_check_catches_blocked_ips() {
        for u in ["http://127.0.0.1/", "http://[::ffff:10.0.0.1]/", "http://100.64.0.9/", "ftp://example.com/"] {
            assert!(url_is_refused_literal(&reqwest::Url::parse(u).unwrap(), Scope::PublicOnly), "{u}");
        }
        for u in ["https://example.com/", "http://1.1.1.1/"] {
            assert!(!url_is_refused_literal(&reqwest::Url::parse(u).unwrap(), Scope::PublicOnly), "{u}");
        }
    }

    /// The guarded client resolves at connect time: a name that lands on a
    /// local listener is refused even with no pre-check, so there is no window
    /// between a check and the connect for a rebind to use.
    #[tokio::test]
    async fn guarded_client_refuses_a_local_name_at_connect_time() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                use tokio::io::AsyncWriteExt;
                let _ = sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi").await;
            }
        });
        let open = reqwest::Client::new().get(format!("http://localhost:{port}/")).send().await;
        assert!(open.is_ok(), "the listener answers an unguarded client");
        let client = client_builder(3).build().unwrap();
        let guarded = client.get(format!("http://localhost:{port}/")).send().await;
        let err = guarded.expect_err("the guarded client must refuse localhost");
        assert!(format!("{err:?}").contains("not allowed"), "{err:?}");
    }

    #[tokio::test]
    async fn error_text_never_quotes_the_url() {
        let e = reqwest::Client::new().get("http://127.0.0.1:1/x?api_key=SECRET42").send().await.unwrap_err();
        assert!(e.to_string().contains("SECRET42"), "reqwest quotes the URL by default");
        assert!(!error_text(e).contains("SECRET42"));
    }

    /// The owner's network scope reaches the LAN, the tailnet and this machine,
    /// but never a cloud metadata endpoint, directly or by redirect.
    #[tokio::test]
    async fn owner_network_scope_allows_the_lan_but_not_metadata() {
        let own = Scope::OwnerNetwork;
        for ok in ["192.168.1.20", "10.0.0.5", "100.101.102.103", "fd7a:115c:a1e0::1", "127.0.0.1", "1.1.1.1"] {
            assert!(!own.blocks(ok.parse().unwrap()), "{ok} is the owner's network");
        }
        for bad in ["169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254", "fe80::1", "::ffff:169.254.169.254"] {
            assert!(own.blocks(bad.parse().unwrap()), "{bad} is a metadata endpoint");
        }
        assert!(resolve("localhost", 80, own).await.is_ok());
        let url = |u: &str| reqwest::Url::parse(u).unwrap();
        assert!(check_url_in(&url("http://169.254.169.254/latest/meta-data/"), own).await.is_err());
        assert!(check_url_in(&url("file:///etc/passwd"), own).await.is_err());
        assert!(url_is_refused_literal(&url("http://169.254.169.254/"), own), "a redirect there is refused");
        assert!(!url_is_refused_literal(&url("http://192.168.1.20/remote.php/dav/"), own));
    }
}
