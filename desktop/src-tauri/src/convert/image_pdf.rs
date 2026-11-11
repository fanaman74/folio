//! Raster images to a one-page PDF.

use super::{ConvertOptions, ImageFit};
use anyhow::{Context, Result};
use flate2::{write::ZlibEncoder, Compression};
use image::metadata::Orientation;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader};
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};
use std::io::Write;
use std::path::Path;

const MM_TO_PT: f32 = 72.0 / 25.4;
/// Screen images are usually authored at 96 pixels per inch.
const PX_TO_PT: f32 = 72.0 / 96.0;

pub fn convert(input: &Path, output: &Path, options: &ConvertOptions) -> Result<()> {
    let bytes = std::fs::read(input).with_context(|| format!("Could not read {}", input.display()))?;
    let reader = ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format()?;
    let format = reader.format();
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(1024 * 1024 * 1024);
    let mut reader = reader;
    reader.limits(limits);
    let mut decoder = reader.into_decoder().context("This image could not be read. Check that it is a valid, complete file.")?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).context("This image could not be read. Check that it is a valid, complete file.")?;
    img.apply_orientation(orientation);
    let (w, h) = img.dimensions();

    // Embed upright baseline JPEGs as-is (no quality loss); everything else is
    // flattened onto white and stored losslessly.
    let upright = orientation == Orientation::NoTransforms;
    let (data, filter, color_space) = match (format, &img) {
        (Some(ImageFormat::Jpeg), DynamicImage::ImageRgb8(_)) if upright => (bytes, "DCTDecode", "DeviceRGB"),
        (Some(ImageFormat::Jpeg), DynamicImage::ImageLuma8(_)) if upright => (bytes, "DCTDecode", "DeviceGray"),
        _ => {
            let rgb = flatten(&img);
            let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
            enc.write_all(rgb.as_raw())?;
            (enc.finish()?, "FlateDecode", "DeviceRGB")
        }
    };

    let img_pt = (w as f32 * PX_TO_PT, h as f32 * PX_TO_PT);
    let (page_w, page_h, draw_w, draw_h) = match options.image_fit {
        ImageFit::Original => (img_pt.0, img_pt.1, img_pt.0, img_pt.1),
        ImageFit::Fit => {
            let (pw, ph) = options.page_mm(w > h);
            let (pw, ph) = (pw * MM_TO_PT, ph * MM_TO_PT);
            let margin = options.margin() * MM_TO_PT;
            let (avail_w, avail_h) = ((pw - 2.0 * margin).max(1.0), (ph - 2.0 * margin).max(1.0));
            // Never enlarge small images past their natural size.
            let scale = (avail_w / img_pt.0).min(avail_h / img_pt.1).min(1.0);
            (pw, ph, img_pt.0 * scale, img_pt.1 * scale)
        }
    };
    let (x, y) = ((page_w - draw_w) / 2.0, (page_h - draw_h) / 2.0);

    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let image_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => w as i64,
            "Height" => h as i64,
            "ColorSpace" => color_space,
            "BitsPerComponent" => 8,
            "Filter" => filter,
        },
        data,
    ));
    let content = Content {
        operations: vec![
            Operation::new("q", vec![]),
            Operation::new("cm", vec![draw_w.into(), 0.into(), 0.into(), draw_h.into(), x.into(), y.into()]),
            Operation::new("Do", vec![Object::Name(b"Im0".to_vec())]),
            Operation::new("Q", vec![]),
        ],
    };
    let content_id = doc.add_object(Stream::new(dictionary! {}, content.encode()?));
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "Contents" => content_id,
        "MediaBox" => vec![0.into(), 0.into(), page_w.into(), page_h.into()],
        "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image_id } },
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1 }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    doc.save(output).with_context(|| format!("Could not write {}", output.display()))?;
    Ok(())
}

/// Composites transparent pixels onto white, since PDF viewers would otherwise show black.
fn flatten(img: &DynamicImage) -> image::RgbImage {
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut out = image::RgbImage::new(w, h);
    for (src, dst) in rgba.pixels().zip(out.pixels_mut()) {
        let a = src[3] as u32;
        for c in 0..3 {
            dst[c] = ((src[c] as u32 * a + 255 * (255 - a)) / 255) as u8;
        }
    }
    out
}
