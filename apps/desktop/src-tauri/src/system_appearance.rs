use std::cell::Cell;

use block2::RcBlock;
use objc2_app_kit::{NSAppearance, NSColor, NSColorSpace};
use objc2_foundation::{NSString, ns_string};

/// Resolve the native accent in both appearances so an app-level theme
/// override uses the matching variant even when the system has another theme.
pub(crate) fn accent_colors() -> Option<[[f64; 3]; 2]> {
    Some([
        accent_color(ns_string!("NSAppearanceNameAqua"))?,
        accent_color(ns_string!("NSAppearanceNameDarkAqua"))?,
    ])
}

fn accent_color(name: &NSString) -> Option<[f64; 3]> {
    let appearance = NSAppearance::appearanceNamed(name)?;
    let components = Cell::new(None);
    let result = &components;
    let resolve_color = RcBlock::new(move || {
        let color =
            NSColor::controlAccentColor().colorUsingColorSpace(&NSColorSpace::sRGBColorSpace());
        result.set(color.map(|color| {
            [
                color.redComponent(),
                color.greenComponent(),
                color.blueComponent(),
            ]
        }));
    });
    appearance.performAsCurrentDrawingAppearance(&resolve_color);
    components.get()
}
