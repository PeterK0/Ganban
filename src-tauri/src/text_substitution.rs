//! Ganban is a markdown app, so its text fields must keep what the user types.
//!
//! On macOS, WKWebView applies the system's "Use smart quotes and dashes" and
//! text-replacement settings to every editable field: typing `---` becomes `—`,
//! which breaks a markdown divider (and `"` becomes `“`, which breaks code).
//! WebKit's UI process decides each substitution by first looking for its own
//! key in the app's user defaults (`WebAutomaticDashSubstitutionEnabled` and
//! friends) and only falls back to the system setting when the key is absent.
//! Registering `false` for those keys at launch, before any webview exists,
//! turns the substitutions off for this app only.
//!
//! The values go in the *registration* domain: nothing is written to disk, and
//! a choice the user makes in Edit ▸ Substitutions still wins. Spell-check and
//! spelling correction are left alone.

/// The WebKit user-defaults keys this module turns off.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const KEYS: [&str; 3] = [
    "WebAutomaticDashSubstitutionEnabled",
    "WebAutomaticQuoteSubstitutionEnabled",
    "WebAutomaticTextReplacementEnabled",
];

/// Register `false` for the substitution keys. Call before any webview is built.
#[cfg(target_os = "macos")]
pub fn disable() {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSDictionary, NSNumber, NSString, NSUserDefaults};

    let keys: Vec<_> = KEYS.iter().map(|k| NSString::from_str(k)).collect();
    let off = NSNumber::new_bool(false);
    let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
    let values: Vec<&AnyObject> = keys.iter().map(|_| &**off as &AnyObject).collect();
    let dict = NSDictionary::from_slices(&key_refs, &values);
    // SAFETY: every key is an NSString and every value an NSNumber, both valid
    // property-list types, which is what -registerDefaults: requires.
    unsafe { NSUserDefaults::standardUserDefaults().registerDefaults(&dict) };
}

#[cfg(not(target_os = "macos"))]
pub fn disable() {}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use objc2_foundation::{NSString, NSUserDefaults};

    #[test]
    fn registers_the_substitution_keys_as_off() {
        super::disable();
        let defaults = NSUserDefaults::standardUserDefaults();
        for key in super::KEYS {
            let key = NSString::from_str(key);
            // Present (so WebKit doesn't fall back to the system setting) and false.
            assert!(defaults.objectForKey(&key).is_some(), "{key} not registered");
            assert!(!defaults.boolForKey(&key), "{key} still on");
        }
    }
}
