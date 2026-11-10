//! Protect portable secrets with the current Windows user's DPAPI key.
use std::{
    io,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
};
use zeroize::{Zeroize, Zeroizing};

pub(crate) fn dpapi(input: &[u8], encrypt: bool) -> io::Result<Zeroizing<Vec<u8>>> {
    let input = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_ptr().cast_mut() };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
    // DPAPI allocates its output with LocalAlloc. Wipe the buffer before freeing it.
    unsafe {
        let ok = if encrypt {
            CryptProtectData(&input, null(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptUnprotectData(&input, null_mut(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        if output.pbData.is_null() {
            return Err(io::Error::other("Windows did not return protected data."));
        }
        let data = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let result = Zeroizing::new(data.to_vec());
        data.zeroize();
        LocalFree(output.pbData.cast());
        Ok(result)
    }
}
