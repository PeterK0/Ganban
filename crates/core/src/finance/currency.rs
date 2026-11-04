//! ISO 4217 codes and their minor-unit exponents. Money is integer minor units (`i64`).

use crate::error::{AppError, Result};

/// The number of decimal places in a currency's minor unit: most are 2.
pub fn exponent(code: &str) -> u32 {
    match code {
        "BIF" | "CLP" | "DJF" | "GNF" | "ISK" | "JPY" | "KMF" | "KRW" | "PYG" | "RWF" | "UGX" | "UYI" | "VND"
        | "VUV" | "XAF" | "XOF" | "XPF" => 0,
        "BHD" | "IQD" | "JOD" | "KWD" | "LYD" | "OMR" | "TND" => 3,
        _ => 2,
    }
}

/// A currency code, upper-cased and checked to be three ASCII letters.
pub fn normalise(code: &str) -> Result<String> {
    let c = code.trim().to_ascii_uppercase();
    if c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase()) {
        Ok(c)
    } else {
        Err(AppError::InvalidInput(format!("'{}' is not a currency code", code.trim())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exponents_and_codes() {
        assert_eq!(exponent("EUR"), 2);
        assert_eq!(exponent("JPY"), 0);
        assert_eq!(exponent("KWD"), 3);
        assert_eq!(normalise(" usd ").unwrap(), "USD");
        assert!(normalise("US").is_err());
        assert!(normalise("U5D").is_err());
    }
}
