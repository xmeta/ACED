# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Project security-reporting and release-history entry points.
- Standalone distribution artifacts now include the WJS runtime and are
  validated in a fresh consumer fixture; GitHub Release is the supported
  distribution path.

## [0.1.0] - 2026-08-12

### Added

- Self-contained GitHub Release artifacts with exact-subject integrity
  verification and consumer bootstrap installation.
- Exact-head stable Release automation with direct tarball and bootstrap
  remote consumer smoke validation.

Future user-visible changes should be added under `Unreleased` and moved to a
versioned section when a release is published. Historical implementation work
before this file was introduced remains available in the Git history.
