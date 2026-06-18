# Changelog

## [0.3.0](https://github.com/dsj1984/mandrel-bench/compare/mandrel-bench-v0.2.0...mandrel-bench-v0.3.0) (2026-06-18)


### Added

* **bench:** batch-ready run orchestrator — resumable, cost-bounded loop (refs [#22](https://github.com/dsj1984/mandrel-bench/issues/22)) ([#24](https://github.com/dsj1984/mandrel-bench/issues/24)) ([9d4d871](https://github.com/dsj1984/mandrel-bench/commit/9d4d871dd352e15d1204ea592f3e0f97dfefa828))
* **bench:** drive the mandrel arm via `/plan --idea --yes` (headless, fresh Epic per run) ([#28](https://github.com/dsj1984/mandrel-bench/issues/28)) ([81d5093](https://github.com/dsj1984/mandrel-bench/commit/81d5093f2020e7892e02b9f2a21c67ce4dbb49a5))
* **bench:** make mandrel-arm runs clean and repeatable ([#27](https://github.com/dsj1984/mandrel-bench/issues/27)) ([4aaf208](https://github.com/dsj1984/mandrel-bench/commit/4aaf208ebdfb19b7aa70dfde1a044a7c4f42146c))
* restructure `results/` into per-cohort directories and add a generated zero-dep `results.html` dashboard ([#17](https://github.com/dsj1984/mandrel-bench/issues/17)) ([#19](https://github.com/dsj1984/mandrel-bench/issues/19)) ([dfe8c13](https://github.com/dsj1984/mandrel-bench/commit/dfe8c13a2e90c3d6e67c71058513ffb9c92a3973))
* **results:** first N=8 baseline cohort — mandrel@1.72.0 / claude-opus-4-8 (refs [#23](https://github.com/dsj1984/mandrel-bench/issues/23)) ([#29](https://github.com/dsj1984/mandrel-bench/issues/29)) ([5100d9d](https://github.com/dsj1984/mandrel-bench/commit/5100d9de2e692b7d19289ad4821fcc23e090608f))


### Fixed

* **bench:** render the value-add report over the full cohort store (resume-safe) ([#31](https://github.com/dsj1984/mandrel-bench/issues/31)) ([e564b3d](https://github.com/dsj1984/mandrel-bench/commit/e564b3daaca733b182c5463e24d97d8da83c054b))
* **bench:** sanitize GITHUB_TOKEN before gh in resetSandboxBaseline ([#30](https://github.com/dsj1984/mandrel-bench/issues/30)) ([a50cfe5](https://github.com/dsj1984/mandrel-bench/commit/a50cfe5c132e24d1a83039646429250a8914f6ae))

## [0.2.0](https://github.com/dsj1984/mandrel-bench/compare/mandrel-bench-v0.1.0...mandrel-bench-v0.2.0) (2026-06-17)


### Added

* **bench:** wire harness end-to-end + first benchmark result (Epic [#2](https://github.com/dsj1984/mandrel-bench/issues/2)) ([#15](https://github.com/dsj1984/mandrel-bench/issues/15)) ([e21c42f](https://github.com/dsj1984/mandrel-bench/commit/e21c42f7bbfac337c636e0b4117f1fbddb63101b))
* bootstrap mandrel-bench — re-home self-benchmark harness from mandrel[#4211](https://github.com/dsj1984/mandrel-bench/issues/4211) ([1287546](https://github.com/dsj1984/mandrel-bench/commit/12875460b9fb626c75e9f4862a8db18c9bcfac57))


### Fixed

* **ci:** exclude generated CHANGELOG from markdownlint (refs [#14](https://github.com/dsj1984/mandrel-bench/issues/14)) ([#18](https://github.com/dsj1984/mandrel-bench/issues/18)) ([88aba4c](https://github.com/dsj1984/mandrel-bench/commit/88aba4cd7060aba0f27378a4a7502eda884d391b))
* **ci:** green up test discovery, markdown lint, and biome config ([d6d3e9e](https://github.com/dsj1984/mandrel-bench/commit/d6d3e9e6e31cc5c56510446f9393b5d3b87e5fb7))
* **docs:** stop MD004 reading "+ noise-band" as a list bullet ([f4ddd0f](https://github.com/dsj1984/mandrel-bench/commit/f4ddd0f70a3c4a06c8fc7732c87b88d197f635d8))

## Changelog

All notable changes to mandrel-bench are documented here. This file is managed
by [release-please](https://github.com/googleapis/release-please) — do not edit
it by hand; it is generated from Conventional Commit subjects on `main`.
