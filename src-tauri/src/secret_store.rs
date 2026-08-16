#[cfg(windows)]
mod windows_dpapi {
    use std::{ffi::c_void, io, ptr, slice};

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "Crypt32")]
    extern "system" {
        fn CryptProtectData(
            data_in: *const DataBlob,
            description: *const u16,
            optional_entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt_struct: *const c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;

        fn CryptUnprotectData(
            data_in: *const DataBlob,
            description: *mut *mut u16,
            optional_entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt_struct: *const c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "Kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    fn encode_hex(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            output.push(HEX[(byte >> 4) as usize] as char);
            output.push(HEX[(byte & 0x0f) as usize] as char);
        }
        output
    }

    fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
        if value.len() % 2 != 0 {
            return Err("受保护密钥格式无效".to_string());
        }
        let bytes = value.as_bytes();
        let mut output = Vec::with_capacity(bytes.len() / 2);
        for pair in bytes.chunks_exact(2) {
            let high = (pair[0] as char)
                .to_digit(16)
                .ok_or_else(|| "受保护密钥格式无效".to_string())?;
            let low = (pair[1] as char)
                .to_digit(16)
                .ok_or_else(|| "受保护密钥格式无效".to_string())?;
            output.push(((high << 4) | low) as u8);
        }
        Ok(output)
    }

    fn protect_bytes(data: &[u8]) -> Result<Vec<u8>, String> {
        let input = DataBlob {
            cb_data: u32::try_from(data.len()).map_err(|_| "密钥过长".to_string())?,
            pb_data: data.as_ptr() as *mut u8,
        };
        let mut output = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };
        let result = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if result == 0 {
            return Err(format!("DPAPI 加密失败：{}", io::Error::last_os_error()));
        }
        let protected = unsafe { slice::from_raw_parts(output.pb_data, output.cb_data as usize) }.to_vec();
        unsafe {
            LocalFree(output.pb_data.cast());
        }
        Ok(protected)
    }

    fn unprotect_bytes(data: &[u8]) -> Result<Vec<u8>, String> {
        let input = DataBlob {
            cb_data: u32::try_from(data.len()).map_err(|_| "受保护密钥过长".to_string())?,
            pb_data: data.as_ptr() as *mut u8,
        };
        let mut output = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };
        let result = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if result == 0 {
            return Err(format!("DPAPI 解密失败：{}", io::Error::last_os_error()));
        }
        let plaintext = unsafe { slice::from_raw_parts(output.pb_data, output.cb_data as usize) }.to_vec();
        unsafe {
            LocalFree(output.pb_data.cast());
        }
        Ok(plaintext)
    }

    pub fn protect(value: &str) -> Result<String, String> {
        protect_bytes(value.as_bytes()).map(|value| encode_hex(&value))
    }

    pub fn unprotect(value: &str) -> Result<String, String> {
        let protected = decode_hex(value)?;
        let plaintext = unprotect_bytes(&protected)?;
        String::from_utf8(plaintext).map_err(|_| "受保护密钥不是有效 UTF-8".to_string())
    }
}

#[cfg(windows)]
pub use windows_dpapi::{protect, unprotect};

#[cfg(not(windows))]
pub fn protect(_value: &str) -> Result<String, String> {
    Err("桌面密钥保护当前仅支持 Windows".to_string())
}

#[cfg(not(windows))]
pub fn unprotect(_value: &str) -> Result<String, String> {
    Err("桌面密钥保护当前仅支持 Windows".to_string())
}
