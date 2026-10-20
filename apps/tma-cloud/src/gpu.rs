//! Which graphics adapter draws the window: a real GPU when there is one, and
//! Windows' software renderer (WARP) on a PC without one. On Windows only
//! DirectX 12 is started (see `options`).

use std::sync::Arc;

use eframe::egui_wgpu::{WgpuConfiguration, WgpuSetup};
use eframe::wgpu::{self, Backend, DeviceType};

/// How well an adapter suits the app; lower is better. A real GPU comes first,
/// DirectX 12 before Vulkan (third-party overlays hook Vulkan and crash it), and
/// a software renderer last.
pub fn rank(backend: Backend, kind: DeviceType) -> u8 {
    let tier = match kind {
        DeviceType::DiscreteGpu => 0,
        DeviceType::IntegratedGpu => 1,
        DeviceType::VirtualGpu | DeviceType::Other => 2,
        DeviceType::Cpu => 3,
    };
    let api = match backend {
        Backend::Dx12 | Backend::Metal => 0,
        Backend::Vulkan => 1,
        _ => 2,
    };
    tier * 3 + api
}

/// eframe's wgpu settings with the app's own adapter choice.
pub fn options() -> WgpuConfiguration {
    let mut config = WgpuConfiguration::default();
    if let WgpuSetup::CreateNew(setup) = &mut config.wgpu_setup {
        setup.native_adapter_selector = Some(Arc::new(select));
        // Every Windows 10 and 11 PC has DirectX 12, on its GPU or through WARP without one.
        // Starting Vulkan and OpenGL too only loads more drivers: on PCs without a GPU those
        // hung or crashed the app. `WGPU_BACKEND` still picks another.
        if cfg!(windows) {
            setup.instance_descriptor.backends = wgpu::Backends::from_env().unwrap_or(wgpu::Backends::DX12);
        }
    }
    config
}

fn select(adapters: &[wgpu::Adapter], surface: Option<&wgpu::Surface<'_>>) -> Result<wgpu::Adapter, String> {
    adapters
        .iter()
        .filter(|a| surface.is_none_or(|s| a.is_surface_supported(s)))
        .min_by_key(|a| {
            let info = a.get_info();
            rank(info.backend, info.device_type)
        })
        .cloned()
        .ok_or_else(|| format!("none of the {} graphics adapters can draw the window", adapters.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gpu_beats_the_software_renderer() {
        assert!(rank(Backend::Dx12, DeviceType::IntegratedGpu) < rank(Backend::Dx12, DeviceType::Cpu));
    }

    #[test]
    fn directx_beats_vulkan_on_the_same_gpu() {
        assert!(rank(Backend::Dx12, DeviceType::DiscreteGpu) < rank(Backend::Vulkan, DeviceType::DiscreteGpu));
        // A discrete GPU on Vulkan still beats an integrated one on DirectX.
        assert!(rank(Backend::Vulkan, DeviceType::DiscreteGpu) < rank(Backend::Dx12, DeviceType::IntegratedGpu));
    }
}
