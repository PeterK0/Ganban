//! Map imagery for the app's map surfaces:
//! a caching tile proxy on the HOST.
//!
//! Clients ask for `/tiles/<layer>/<z>/<x>/<y>`; the host fetches the tile from
//! the owner-configured imagery provider, keeps it in a disk cache under the
//! storage root, and serves the cached copy — stale if need be — when the
//! provider is unreachable. Why a proxy instead of tiles straight from the
//! provider in the webview:
//!
//! - **Keys stay on the host** (the GIPHY pattern): a keyed provider's key is an
//!   owner-only app_setting injected here, never shipped to a client.
//! - **No SSRF surface**: provider URLs are compiled-in templates. A client can
//!   only name a layer from a fixed list and three bounded integers.
//! - **Tailnet/offline-first**: phones and browsers on the tailnet reuse the
//!   host's cache; areas already viewed keep working when the internet doesn't.
//! - **One transport**: the built desktop app reaches remote hosts through the
//!   Rust tunnel (mixed-content rules), so the map must load through the daemon.
//!
//! Imagery is external content: it's capped, type-checked (JPEG/PNG/WebP magic
//! bytes only) and rendered as pixels — never interpreted.

use std::path::{Path as FsPath, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use ganban_core::{ops, Db};
use serde::Serialize;

/// One imagery layer a provider offers.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Layer {
    pub id: &'static str,
    pub name: &'static str,
    /// `{z}`, `{x}`, `{y}` and (if the provider is keyed) `{key}` placeholders.
    #[serde(skip)]
    pub template: &'static str,
    pub max_zoom: u8,
    pub attribution: &'static str,
    /// An overlay (labels/boundaries) drawn over a base layer, not a base itself.
    pub overlay: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Provider {
    pub id: &'static str,
    pub name: &'static str,
    pub needs_key: bool,
    /// Shown to the owner when choosing: licensing is THEIR call.
    pub terms: &'static str,
    pub layers: &'static [Layer],
}

const ESRI_IMAGERY_ATTR: &str = "Imagery © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community";

pub const PROVIDERS: &[Provider] = &[
    Provider {
        id: "esri",
        name: "Esri World Imagery",
        needs_key: false,
        terms: "Free basemap service with attribution; production or commercial use requires an ArcGIS account under Esri's terms of use.",
        layers: &[
            Layer {
                id: "satellite",
                name: "Satellite",
                template: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
                max_zoom: 19,
                attribution: ESRI_IMAGERY_ATTR,
                overlay: false,
            },
            Layer {
                id: "ocean",
                name: "Ocean (bathymetry)",
                template: "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}",
                max_zoom: 13,
                attribution: "Tiles © Esri — Sources: GEBCO, NOAA, CHS, OSU, UNH, CSUMB, National Geographic, DeLorme, NAVTEQ, and Esri",
                overlay: false,
            },
            Layer {
                id: "labels",
                name: "Place names & borders",
                template: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
                max_zoom: 19,
                attribution: "Labels © Esri",
                overlay: true,
            },
        ],
    },
    Provider {
        id: "maptiler",
        name: "MapTiler Satellite",
        needs_key: true,
        terms: "Commercial service with a free tier; requires a MapTiler API key (cloud.maptiler.com).",
        layers: &[Layer {
            id: "satellite",
            name: "Satellite",
            template: "https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key={key}",
            max_zoom: 20,
            attribution: "© MapTiler © OpenStreetMap contributors",
            overlay: false,
        }],
    },
    Provider {
        id: "eox",
        name: "Sentinel-2 cloudless (EOX)",
        needs_key: false,
        terms: "10 m Copernicus Sentinel-2 mosaic, CC BY-NC-SA 4.0 — NON-COMMERCIAL use only.",
        layers: &[Layer {
            id: "satellite",
            name: "Satellite (Sentinel-2, 10 m)",
            template: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg",
            max_zoom: 15,
            attribution: "Sentinel-2 cloudless — s2maps.eu by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2023)",
            overlay: false,
        }],
    },
];

pub const SETTING_PROVIDER: &str = "map_imagery_provider";
pub const SETTING_KEY: &str = "map_imagery_key";
const DEFAULT_PROVIDER: &str = "esri";

/// How long a cached tile is served without asking the provider again.
const FRESH_FOR: Duration = Duration::from_secs(30 * 24 * 3600);
/// Disk budget for the cache; pruned oldest-first back to 80% when exceeded.
const CACHE_CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_TILE_BYTES: usize = 2 * 1024 * 1024;

/// The provider the owner chose (`None` = imagery switched off).
pub async fn active_provider(db: &Db) -> Option<&'static Provider> {
    let id = ops::get_app_setting(db, SETTING_PROVIDER)
        .await
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());
    if id == "off" {
        return None;
    }
    PROVIDERS.iter().find(|p| p.id == id).or_else(|| PROVIDERS.iter().find(|p| p.id == DEFAULT_PROVIDER))
}

pub fn layer_of(p: &'static Provider, layer: &str) -> Option<&'static Layer> {
    p.layers.iter().find(|l| l.id == layer)
}

/// Bounds-check a tile address against the layer.
pub fn valid_tile(layer: &Layer, z: u8, x: u32, y: u32) -> bool {
    if z > layer.max_zoom || z > 22 {
        return false;
    }
    let n = 1u64 << z;
    (x as u64) < n && (y as u64) < n
}

/// Fill a provider template. The key is URL-safe-checked by the caller.
pub fn tile_url(layer: &Layer, z: u8, x: u32, y: u32, key: &str) -> String {
    layer
        .template
        .replace("{z}", &z.to_string())
        .replace("{x}", &x.to_string())
        .replace("{y}", &y.to_string())
        .replace("{key}", key)
}

/// Image type by magic bytes — anything else is refused, whatever the
/// provider's Content-Type says.
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

pub fn cache_path(root: &FsPath, provider: &str, layer: &str, z: u8, x: u32, y: u32) -> PathBuf {
    root.join("tile-cache").join(provider).join(layer).join(z.to_string()).join(x.to_string()).join(y.to_string())
}

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(concat!("Ganban/", env!("CARGO_PKG_VERSION"), " (self-hosted map tile cache)"))
            .build()
            .expect("tile http client")
    })
}

/// At most a handful of upstream fetches at once — a fast pan must not turn
/// the host into a firehose against the provider.
fn upstream_permits() -> &'static tokio::sync::Semaphore {
    static S: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    S.get_or_init(|| tokio::sync::Semaphore::new(8))
}

pub enum TileError {
    Off,
    NotFound,
    BadRequest(&'static str),
    Upstream(String),
}

pub struct Tile {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
    /// Served from cache past its freshness because the provider failed.
    pub stale: bool,
}

/// Cache-first tile fetch with stale-on-error.
pub async fn get_tile(db: &Db, root: &FsPath, layer: &str, z: u8, x: u32, y: u32) -> Result<Tile, TileError> {
    let provider = active_provider(db).await.ok_or(TileError::Off)?;
    let l = layer_of(provider, layer).ok_or(TileError::NotFound)?;
    if !valid_tile(l, z, x, y) {
        return Err(TileError::BadRequest("tile address out of range"));
    }
    let path = cache_path(root, provider.id, l.id, z, x, y);

    let cached = tokio::fs::read(&path).await.ok().and_then(|b| sniff_image(&b).map(|ct| (b, ct)));
    if let Some((bytes, ct)) = &cached {
        let fresh = tokio::fs::metadata(&path)
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age < FRESH_FOR);
        if fresh {
            return Ok(Tile { bytes: bytes.clone(), content_type: ct, stale: false });
        }
    }

    let key = if provider.needs_key {
        let k = ops::get_app_setting(db, SETTING_KEY).await.ok().flatten().unwrap_or_default();
        let k = k.trim().to_string();
        if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
            return Err(TileError::Upstream(format!("{} needs an API key (Settings → Plug-ins → Map imagery)", provider.name)));
        }
        k
    } else {
        String::new()
    };

    match fetch_upstream(&tile_url(l, z, x, y, &key)).await {
        Ok((bytes, ct)) => {
            write_cache(&path, &bytes).await;
            Ok(Tile { bytes, content_type: ct, stale: false })
        }
        Err(UpstreamErr::NotFound) => Err(TileError::NotFound),
        Err(UpstreamErr::Other(e)) => match cached {
            Some((bytes, ct)) => Ok(Tile { bytes, content_type: ct, stale: true }),
            None => Err(TileError::Upstream(e)),
        },
    }
}

enum UpstreamErr {
    NotFound,
    Other(String),
}

async fn fetch_upstream(url: &str) -> Result<(Vec<u8>, &'static str), UpstreamErr> {
    let _permit = upstream_permits().acquire().await.map_err(|e| UpstreamErr::Other(e.to_string()))?;
    let resp = client().get(url).send().await.map_err(|e| UpstreamErr::Other(format!("imagery provider unreachable: {e}")))?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(UpstreamErr::NotFound);
    }
    if !status.is_success() {
        let hint = if status.as_u16() == 401 || status.as_u16() == 403 { " — check the API key / account" } else { "" };
        return Err(UpstreamErr::Other(format!("imagery provider answered {status}{hint}")));
    }
    if resp.content_length().is_some_and(|n| n as usize > MAX_TILE_BYTES) {
        return Err(UpstreamErr::Other("tile too large".into()));
    }
    let bytes = resp.bytes().await.map_err(|e| UpstreamErr::Other(e.to_string()))?;
    if bytes.len() > MAX_TILE_BYTES {
        return Err(UpstreamErr::Other("tile too large".into()));
    }
    let ct = sniff_image(&bytes).ok_or_else(|| UpstreamErr::Other("provider returned something that isn't an image".into()))?;
    Ok((bytes.to_vec(), ct))
}

static WRITES: AtomicU64 = AtomicU64::new(0);

async fn write_cache(path: &FsPath, bytes: &[u8]) {
    if let Some(dir) = path.parent() {
        if tokio::fs::create_dir_all(dir).await.is_err() {
            return;
        }
    }
    // Write-then-rename: a reader never sees half a tile.
    let tmp = path.with_extension("part");
    if tokio::fs::write(&tmp, bytes).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, path).await;
    }
    if WRITES.fetch_add(1, Ordering::Relaxed) % 500 == 499 {
        if let Some(cache_root) = path.ancestors().find(|a| a.file_name().is_some_and(|n| n == "tile-cache")) {
            let cache_root = cache_root.to_path_buf();
            tokio::task::spawn_blocking(move || prune(&cache_root, CACHE_CAP_BYTES));
        }
    }
}

/// Keep the cache under `cap`: when over, delete least-recently-written tiles
/// until it's back to 80%. Returns bytes removed.
pub fn prune(cache_root: &FsPath, cap: u64) -> u64 {
    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut stack = vec![cache_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                stack.push(e.path());
            } else {
                files.push((e.path(), md.len(), md.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
            }
        }
    }
    let total: u64 = files.iter().map(|f| f.1).sum();
    if total <= cap {
        return 0;
    }
    files.sort_by_key(|f| f.2);
    let target = cap / 10 * 8;
    let mut now = total;
    let mut removed = 0;
    for (p, size, _) in files {
        if now <= target {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            now -= size;
            removed += size;
        }
    }
    removed
}

/// What the client needs to set up its map: the active provider, its layers
/// (with the attribution the map MUST display) — never the key.
pub async fn client_config(db: &Db) -> serde_json::Value {
    let all: Vec<serde_json::Value> = PROVIDERS
        .iter()
        .map(|p| serde_json::json!({ "id": p.id, "name": p.name, "needsKey": p.needs_key, "terms": p.terms }))
        .collect();
    match active_provider(db).await {
        None => serde_json::json!({ "provider": null, "layers": [], "providers": all }),
        Some(p) => serde_json::json!({
            "provider": p.id,
            "providerName": p.name,
            "terms": p.terms,
            "layers": p.layers.iter().map(|l| serde_json::json!({
                "id": l.id, "name": l.name, "maxZoom": l.max_zoom, "attribution": l.attribution, "overlay": l.overlay,
            })).collect::<Vec<_>>(),
            "providers": all,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(p: &str, l: &str) -> &'static Layer {
        layer_of(PROVIDERS.iter().find(|x| x.id == p).unwrap(), l).unwrap()
    }

    #[test]
    fn tile_addresses_are_bounded() {
        let sat = layer("esri", "satellite");
        assert!(valid_tile(sat, 0, 0, 0));
        assert!(!valid_tile(sat, 0, 1, 0), "x beyond 2^z");
        assert!(valid_tile(sat, 3, 7, 7));
        assert!(!valid_tile(sat, 3, 8, 0));
        assert!(!valid_tile(sat, 20, 0, 0), "beyond the layer's max zoom");
        assert!(!valid_tile(layer("esri", "ocean"), 14, 0, 0));
    }

    #[test]
    fn templates_fill_only_the_placeholders() {
        let sat = layer("esri", "satellite");
        assert_eq!(
            tile_url(sat, 5, 10, 12, ""),
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/5/12/10"
        );
        let mt = layer("maptiler", "satellite");
        assert_eq!(tile_url(mt, 2, 1, 3, "abc"), "https://api.maptiler.com/tiles/satellite-v2/2/1/3.jpg?key=abc");
        for p in PROVIDERS {
            for l in p.layers {
                assert!(l.template.starts_with("https://"), "{}:{} must be https", p.id, l.id);
                assert_eq!(p.needs_key, l.template.contains("{key}"), "{}:{} key placeholder ⇔ needs_key", p.id, l.id);
            }
        }
    }

    #[test]
    fn only_real_images_pass() {
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"<html>nope</html>"), None);
        assert_eq!(sniff_image(b""), None);
    }

    #[test]
    fn cache_layout_and_pruning() {
        let dir = std::env::temp_dir().join(format!("ganban_tiles_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = cache_path(&dir, "esri", "satellite", 3, 4, 5);
        assert!(p.ends_with("tile-cache/esri/satellite/3/4/5"));
        let cache = dir.join("tile-cache");
        for i in 0..10u32 {
            let f = cache_path(&dir, "esri", "satellite", 4, i, 0);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(&f, vec![0u8; 1000]).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(prune(&cache, 20_000), 0, "under the cap: untouched");
        let removed = prune(&cache, 5_000);
        assert!(removed >= 6_000, "pruned back to 80% of the cap (removed {removed})");
        assert!(!cache_path(&dir, "esri", "satellite", 4, 0, 0).exists(), "oldest go first");
        assert!(cache_path(&dir, "esri", "satellite", 4, 9, 0).exists(), "newest stay");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod live {
    //! Hits the real provider — run explicitly: `cargo test maptiles::live -- --ignored`.
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn esri_tile_round_trip_and_cache() {
        let dbp = std::env::temp_dir().join(format!("ganban_tiles_live_{}.db", std::process::id()));
        let db = ganban_core::init_db(&dbp).await.unwrap();
        let root = std::env::temp_dir().join(format!("ganban_tiles_live_root_{}", std::process::id()));
        // Rotterdam at z10: x=523, y=336
        let t = get_tile(&db, &root, "satellite", 10, 523, 336).await.ok().expect("tile");
        assert_eq!(t.content_type, "image/jpeg");
        assert!(t.bytes.len() > 1000);
        assert!(cache_path(&root, "esri", "satellite", 10, 523, 336).exists(), "cached");
        let o = get_tile(&db, &root, "ocean", 5, 16, 10).await.ok().expect("ocean tile");
        assert!(o.bytes.len() > 500);
        let l = get_tile(&db, &root, "labels", 5, 16, 10).await.ok().expect("labels tile");
        assert_eq!(l.content_type, "image/png");
        ops::set_app_setting(&db, SETTING_PROVIDER, "eox").await.unwrap();
        let e = get_tile(&db, &root, "satellite", 6, 33, 21).await.ok().expect("eox tile");
        assert!(e.bytes.len() > 1000);
        let _ = std::fs::remove_dir_all(&root);
    }
}
