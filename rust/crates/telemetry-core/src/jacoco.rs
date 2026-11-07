//! jacoco.rs — Streaming parser for JaCoCo XML coverage reports.
//!
//! Uses quick-xml to stream through <package> and <sourcefile> elements,
//! extracting line-level coverage without loading the entire XML document into a DOM.

use crate::types::FileCoverage;
use anyhow::{anyhow, Result};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use std::collections::BTreeMap;
use std::io::BufRead;

pub fn parse_jacoco_xml<R: BufRead>(reader: R) -> Result<BTreeMap<String, FileCoverage>> {
    let mut xml_reader = Reader::from_reader(reader);
    xml_reader.config_mut().trim_text(true);

    let mut coverage_map = BTreeMap::new();
    let mut current_package = String::new();
    let mut current_sourcefile: Option<String> = None;
    let mut covered_lines = Vec::new();
    let mut missed_lines = Vec::new();

    let mut buf = Vec::new();
    loop {
        match xml_reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match e.name().as_ref() {
                b"package" => {
                    for attr in e.attributes() {
                        let attr = attr
                            .map_err(|err| anyhow!("Error reading package attribute: {}", err))?;
                        if attr.key.as_ref() == b"name" {
                            current_package =
                                String::from_utf8_lossy(&attr.value).replace('\\', "/");
                        }
                    }
                }
                b"sourcefile" => {
                    for attr in e.attributes() {
                        let attr = attr.map_err(|err| {
                            anyhow!("Error reading sourcefile attribute: {}", err)
                        })?;
                        if attr.key.as_ref() == b"name" {
                            current_sourcefile =
                                Some(String::from_utf8_lossy(&attr.value).to_string());
                            covered_lines.clear();
                            missed_lines.clear();
                        }
                    }
                }
                b"line" => {
                    if current_sourcefile.is_some() {
                        let mut line_nr: Option<u32> = None;
                        let mut mi: u32 = 0;
                        let mut ci: u32 = 0;

                        for attr in e.attributes() {
                            let attr = attr
                                .map_err(|err| anyhow!("Error reading line attribute: {}", err))?;
                            match attr.key.as_ref() {
                                b"nr" => {
                                    line_nr = std::str::from_utf8(&attr.value)
                                        .ok()
                                        .and_then(|s| s.parse().ok());
                                }
                                b"mi" => {
                                    mi = std::str::from_utf8(&attr.value)
                                        .ok()
                                        .and_then(|s| s.parse().ok())
                                        .unwrap_or(0);
                                }
                                b"ci" => {
                                    ci = std::str::from_utf8(&attr.value)
                                        .ok()
                                        .and_then(|s| s.parse().ok())
                                        .unwrap_or(0);
                                }
                                _ => {}
                            }
                        }

                        if let Some(nr) = line_nr {
                            if ci > 0 {
                                covered_lines.push(nr);
                            } else if mi > 0 {
                                missed_lines.push(nr);
                            }
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::End(e)) => match e.name().as_ref() {
                b"sourcefile" => {
                    if let Some(src) = current_sourcefile.take() {
                        let full_path = if current_package.is_empty() {
                            src
                        } else {
                            format!("{}/{}", current_package.trim_end_matches('/'), src)
                        };

                        covered_lines.sort_unstable();
                        covered_lines.dedup();
                        missed_lines.sort_unstable();
                        missed_lines.dedup();

                        let total = (covered_lines.len() + missed_lines.len()) as u32;
                        let ratio = if total > 0 {
                            covered_lines.len() as f64 / total as f64
                        } else {
                            0.0
                        };

                        coverage_map.insert(
                            full_path,
                            FileCoverage {
                                covered_lines: covered_lines.clone(),
                                missed_lines: missed_lines.clone(),
                                total_lines: total,
                                line_coverage_ratio: (ratio * 10000.0).round() / 10000.0,
                            },
                        );
                    }
                }
                b"package" => {
                    current_package.clear();
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => {
                return Err(anyhow!(
                    "Error parsing JaCoCo XML at position {}: {}",
                    xml_reader.buffer_position(),
                    e
                ))
            }
        }
        buf.clear();
    }

    Ok(coverage_map)
}
