//! Strict decoding for source files. The detected encoding and BOM travel
//! separately from the text so a working-file save can preserve both.
use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::Serialize;

use super::runner::{GitError, GitResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Codec {
    Standard(&'static Encoding),
    Utf32Le,
    Utf32Be,
}

impl Codec {
    pub(super) fn from_label(label: &str) -> GitResult<Self> {
        match label.trim().to_ascii_lowercase().as_str() {
            "utf-32le" | "utf32le" => Ok(Self::Utf32Le),
            "utf-32be" | "utf32be" => Ok(Self::Utf32Be),
            _ => Encoding::for_label_no_replacement(label.as_bytes())
                .map(Self::Standard)
                .ok_or_else(|| GitError::new("Choose a supported text encoding.").kind("invalid-encoding")),
        }
    }

    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Standard(encoding) => encoding.name(),
            Self::Utf32Le => "UTF-32LE",
            Self::Utf32Be => "UTF-32BE",
        }
    }

    pub(super) fn bom(self) -> Option<&'static [u8]> {
        match self {
            Self::Standard(encoding) if encoding == UTF_8 => Some(b"\xef\xbb\xbf"),
            Self::Standard(encoding) if encoding == UTF_16LE => Some(b"\xff\xfe"),
            Self::Standard(encoding) if encoding == UTF_16BE => Some(b"\xfe\xff"),
            Self::Utf32Le => Some(b"\xff\xfe\x00\x00"),
            Self::Utf32Be => Some(b"\x00\x00\xfe\xff"),
            _ => None,
        }
    }

    fn decode(self, bytes: &[u8]) -> Option<String> {
        match self {
            Self::Standard(encoding) => encoding.decode_without_bom_handling_and_without_replacement(bytes).map(|text| text.into_owned()),
            Self::Utf32Le | Self::Utf32Be => {
                let (units, remainder) = bytes.as_chunks::<4>();
                if !remainder.is_empty() {
                    return None;
                }
                units.iter().map(|&unit| char::from_u32(if self == Self::Utf32Le { u32::from_le_bytes(unit) } else { u32::from_be_bytes(unit) })).collect()
            }
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedText {
    pub content: String,
    pub encoding: &'static str,
    pub bom: bool,
    pub guessed: bool,
}

fn readable(text: &str) -> bool {
    text.chars().all(|ch| !ch.is_control() || matches!(ch, '\t' | '\n' | '\r' | '\u{b}' | '\u{c}' | '\u{1b}' | '\u{85}'))
}

fn binary_signature(bytes: &[u8]) -> bool {
    let signatures: &[&[u8]] = &[
        b"\x89PNG\r\n\x1a\n",
        b"\xff\xd8\xff",
        b"GIF87a",
        b"GIF89a",
        b"PK\x03\x04",
        b"PK\x05\x06",
        b"\x7fELF",
        b"\x1f\x8b\x08",
        b"%PDF-",
        b"SQLite format 3\0",
    ];
    signatures.iter().any(|signature| bytes.starts_with(signature))
}

fn decoded(codec: Codec, bytes: &[u8], bom: bool, guessed: bool) -> Option<DecodedText> {
    let content = codec.decode(bytes)?;
    readable(&content).then(|| DecodedText { content, encoding: codec.name(), bom, guessed })
}

fn wide_without_bom(bytes: &[u8]) -> Option<DecodedText> {
    let sample = &bytes[..bytes.len().min(4096)];
    if bytes.len().is_multiple_of(4) && sample.len() >= 16 {
        let (chunks, _) = sample.as_chunks::<4>();
        let units = chunks.len();
        let lanes = chunks.iter().fold([0; 4], |mut sums, unit| {
            for (sum, byte) in sums.iter_mut().zip(unit) {
                *sum += usize::from(*byte == 0);
            }
            sums
        });
        for (codec, low, high, top) in [(Codec::Utf32Le, 0, 2, 3), (Codec::Utf32Be, 3, 1, 0)] {
            if lanes[top] == units && lanes[high] * 4 >= units * 3 && lanes[low] * 2 < units {
                if let Some(text) = decoded(codec, bytes, false, true) {
                    return Some(text);
                }
            }
        }
    }
    if !bytes.len().is_multiple_of(2) || sample.len() < 4 {
        return None;
    }
    let (chunks, _) = sample.as_chunks::<2>();
    let units = chunks.len();
    let lanes = chunks.iter().fold([0; 2], |mut sums, unit| {
        for (sum, byte) in sums.iter_mut().zip(unit) {
            *sum += usize::from(*byte <= 8);
        }
        sums
    });
    for (codec, low, high) in [(Codec::Standard(UTF_16LE), 0, 1), (Codec::Standard(UTF_16BE), 1, 0)] {
        if lanes[high] * 2 >= units && lanes[high] > lanes[low] * 2 {
            if let Some(text) = decoded(codec, bytes, false, true) {
                return Some(text);
            }
        }
    }
    None
}

pub(super) fn decode(bytes: &[u8], encoding: Option<&str>) -> GitResult<Option<DecodedText>> {
    let bom = [Codec::Utf32Le, Codec::Utf32Be, Codec::Standard(UTF_8), Codec::Standard(UTF_16LE), Codec::Standard(UTF_16BE)]
        .into_iter()
        .find_map(|codec| bytes.strip_prefix(codec.bom()?).map(|rest| (codec, rest)));
    if let Some(label) = encoding {
        let codec = Codec::from_label(label)?;
        let matching_bom = bom.filter(|(marked, _)| *marked == codec);
        return Ok(decoded(codec, matching_bom.map_or(bytes, |(_, rest)| rest), matching_bom.is_some(), false));
    }
    if let Some((codec, bytes)) = bom {
        return Ok(decoded(codec, bytes, true, false));
    }
    if binary_signature(bytes) {
        return Ok(None);
    }
    if bytes.windows(3).any(|sequence| matches!(sequence, b"\x1b$B" | b"\x1b$@")) {
        if let Some(text) = decoded(Codec::Standard(encoding_rs::ISO_2022_JP), bytes, false, true) {
            return Ok(Some(text));
        }
    }
    if let Some(text) = decoded(Codec::Standard(UTF_8), bytes, false, false) {
        return Ok(Some(text));
    }
    if let Some(text) = wide_without_bom(bytes) {
        return Ok(Some(text));
    }
    if bytes.iter().any(|byte| *byte < 32 && !matches!(*byte, b'\t' | b'\n' | b'\r' | 11 | 12 | 27)) {
        return Ok(None);
    }
    let mut detector = EncodingDetector::new(Iso2022JpDetection::Allow);
    detector.feed(bytes, true);
    let codec = Codec::Standard(detector.guess(None, Utf8Detection::Deny));
    Ok(decoded(codec, bytes, false, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_wide_text_and_legacy_text_from_binary() {
        let sample = "Initial text\r\nПривет\r\n";
        let le: Vec<u8> = sample.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let marked = [b"\xff\xfe".as_slice(), &le].concat();
        let text = decode(&marked, None).unwrap().unwrap();
        assert_eq!(text.content, sample);
        assert_eq!(text.encoding, "UTF-16LE");
        assert!(text.bom && !text.guessed);
        let text = decode(&le, None).unwrap().unwrap();
        assert_eq!(text.content, sample);
        assert!(!text.bom && text.guessed);
        let be: Vec<u8> = sample.chars().flat_map(|ch| (ch as u32).to_be_bytes()).collect();
        assert_eq!(decode(&be, None).unwrap().unwrap().encoding, "UTF-32BE");
        let cp = b"\xcf\xf0\xe8\xe2\xe5\xf2";
        assert_eq!(decode(cp, Some("windows-1251")).unwrap().unwrap().content, "Привет");
        assert!(decode(b"\x89PNG\r\n\x1a\n", None).unwrap().is_none());
        assert!(decode(b"\x00\x01\x00\x02\x00\xff\x00\x10", None).unwrap().is_none());
    }
}
