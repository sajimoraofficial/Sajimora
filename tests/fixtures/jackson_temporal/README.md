# Jackson Temporal Fixture Specifications & Dependency Inspection

## Overview

This directory contains fixture specifications for Java temporal wire type representation under different Jackson serialization configurations.

> **IMPORTANT**: These fixture specifications define target expectations, **not** validated outputs. Gate G3 and Architectural Decision D9 strictly gate implementation based on these specifications.

## Pinned Versions Inspection & Gate G3

- The file [`pinned_versions.json`](pinned_versions.json) documents the Jackson library versions identified within pilot repository artifacts (such as Apache Fineract and related dependencies).
- Prior to implementing active Jackson temporal wire semantics in `JavaWireModelEngine`, the `versionResolutionStatus` in [`pinned_versions.json`](pinned_versions.json) must be transitioned from `PENDING_CONFIRMATION` to `CONFIRMED`.
- **Gate G3** requires that every temporal type entry in [`temporal_wire_expectations.json`](temporal_wire_expectations.json) has a passing golden integration test against the verified, pinned Jackson runtime (`jackson-databind` and `jackson-datatype-jsr310`).
- Until Gate G3 criteria are fully satisfied, any unverified or profile-dependent temporal serialization configurations must fail closed by emitting `UNRESOLVED_JACKSON_CONFIG` or `UNSUPPORTED_JACKSON_FEATURE` blockers.

## Architectural Decision D9

This fixture suite is governed by **Architectural Decision D9 (Jackson Temporal Wire Semantics and Qualification Gate)**:
1. **Lattice Soundness**: Wire type extraction must maintain sound, fail-closed contracts. When `SerializationFeature.WRITE_DATES_AS_TIMESTAMPS` is active or customized via object mappers, the wire format changes from scalar strings to numeric epoch timestamps or structured integer arrays (e.g., `[year, month, day]` for `java.time.LocalDate`).
2. **Mandatory Version Pinning**: Temporal module behavior across Jackson versions (specifically `JavaTimeModule` in Jackson 2.x vs 3.x) exhibits subtle serialization differences (e.g., nanosecond precision, array length variants, and `java.time.Period` wire formats).
3. **Strict Gate Order**: No production code paths in `JavaWireModelEngine` or `JacksonSnapshotConfig` may assume or synthesize numeric/array temporal formats without passing golden evidence under Gate G3.

## Files

- [`pinned_versions.json`](pinned_versions.json): Record of inspected dependency versions across pilot artifacts, verification blockers, and confirmation action items.
- [`temporal_wire_expectations.json`](temporal_wire_expectations.json): Matrix of expected wire shapes for `Instant`, `Date`, `LocalDate`, `LocalTime`, `LocalDateTime`, `OffsetDateTime`, and `Period` under timestamp-disabled vs timestamp-enabled configurations.
