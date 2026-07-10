# Changelog

## [0.9.0](https://github.com/dsj1984/mandrel-bench/compare/mandrel-bench-v0.8.0...mandrel-bench-v0.9.0) (2026-07-10)


### Fixed

* **bench:** abort a cell on a transient session failure instead of degrading it ([#111](https://github.com/dsj1984/mandrel-bench/issues/111)) ([7248247](https://github.com/dsj1984/mandrel-bench/commit/724824789c07eee465d55747e3bc6d4637a6aa4a))
* **bench:** pre-trust throwaway workspaces so headless claude -p runs clean ([#109](https://github.com/dsj1984/mandrel-bench/issues/109)) ([3eae098](https://github.com/dsj1984/mandrel-bench/commit/3eae098eb80b8b1954a5fbff7c6f20eed20f4b7f))

## [0.8.0](https://github.com/dsj1984/mandrel-bench/compare/mandrel-bench-v0.7.0...mandrel-bench-v0.8.0) (2026-07-10)


### Added

* **results:** smoke cohort 2026-07-10 — mandrel@1.88.0 / claude-opus-4-8 ([#106](https://github.com/dsj1984/mandrel-bench/issues/106)) ([324ea13](https://github.com/dsj1984/mandrel-bench/commit/324ea1314ad1316a83161f70ed224b2c193efd65))


### Fixed

* **bench:** wire the maintainability/security LLM judge to a real transport ([#107](https://github.com/dsj1984/mandrel-bench/issues/107)) ([03f3d42](https://github.com/dsj1984/mandrel-bench/commit/03f3d42df5fc29bb57b68535d5218b2df67943a6))

## [0.7.0](https://github.com/dsj1984/mandrel-bench/compare/mandrel-bench-v0.6.0...mandrel-bench-v0.7.0) (2026-07-10)


### Added

* **bench:** finish target architecture (feedback phase tags, version override, shim cleanup) ([#102](https://github.com/dsj1984/mandrel-bench/issues/102)) ([93bc58e](https://github.com/dsj1984/mandrel-bench/commit/93bc58e4786f330cc61ae74af66a02affca59eac))

## [0.6.0](https://github.com/dsj1984/mandrel-bench/compare/mandrel-bench-v0.5.0...mandrel-bench-v0.6.0) (2026-07-10)


### Added

* Epic [#65](https://github.com/dsj1984/mandrel-bench/issues/65) ([#81](https://github.com/dsj1984/mandrel-bench/issues/81)) ([6c950f3](https://github.com/dsj1984/mandrel-bench/commit/6c950f3ed533b5ccf04ee350caf02468fdbd5d39))
* Epic [#66](https://github.com/dsj1984/mandrel-bench/issues/66) ([#83](https://github.com/dsj1984/mandrel-bench/issues/83)) ([f64ca4d](https://github.com/dsj1984/mandrel-bench/commit/f64ca4d540ddfd2750a6b03dec3d5ce06e0e1712))
* Epic [#84](https://github.com/dsj1984/mandrel-bench/issues/84) ([#98](https://github.com/dsj1984/mandrel-bench/issues/98)) ([f327bae](https://github.com/dsj1984/mandrel-bench/commit/f327bae56ebb29d67bb569210dbe19216f78ec6e))
* Epic [#85](https://github.com/dsj1984/mandrel-bench/issues/85) ([#99](https://github.com/dsj1984/mandrel-bench/issues/99)) ([d99d112](https://github.com/dsj1984/mandrel-bench/commit/d99d112a2d4c59e9d7c7d62b1b8b7ab1b15c7585))
* Epic [#86](https://github.com/dsj1984/mandrel-bench/issues/86) ([#100](https://github.com/dsj1984/mandrel-bench/issues/100)) ([597d1df](https://github.com/dsj1984/mandrel-bench/commit/597d1dfe2df183fd97674b142e86c7227bd607a8))


### Fixed

* **bench:** make janitor sweep tests clock-deterministic ([#101](https://github.com/dsj1984/mandrel-bench/issues/101)) ([d87c5a2](https://github.com/dsj1984/mandrel-bench/commit/d87c5a2728516786e6c1fc952da2277c3e5ed5f1))

## [0.5.0](https://github.com/dsj1984/mandrel-bench/compare/mandrel-bench-v0.4.0...mandrel-bench-v0.5.0) (2026-06-24)


### Added

* **bench:** differential-trap spike apparatus — auth-trap scenario (refs [#57](https://github.com/dsj1984/mandrel-bench/issues/57)) ([#63](https://github.com/dsj1984/mandrel-bench/issues/63)) ([b60e2f1](https://github.com/dsj1984/mandrel-bench/commit/b60e2f16e606861f45a660e70d05acd75dd762d1))
* **results:** 1.75.0 cohort — mandrel@1.75.0 / claude-opus-4-8 ([#62](https://github.com/dsj1984/mandrel-bench/issues/62)) ([e888d0c](https://github.com/dsj1984/mandrel-bench/commit/e888d0c016e88b2d42b0700282deebdc67e6ecea))


### Fixed

* **bench:** git-exclude the framework overlay so it never enters the deliverable diff ([#58](https://github.com/dsj1984/mandrel-bench/issues/58)) ([97e5e1e](https://github.com/dsj1984/mandrel-bench/commit/97e5e1edc22edf516bc77fcf1aa9b6d4e83e118c))
* **bench:** security scanner measured the overlaid framework, not the deliverable ([#53](https://github.com/dsj1984/mandrel-bench/issues/53)) ([54802d8](https://github.com/dsj1984/mandrel-bench/commit/54802d8d324bdb49af0f22bdf2cc6b32cadf0d9d))
* **bench:** stop counting test-fixture creds as secrets; proportional secret penalty (refs [#55](https://github.com/dsj1984/mandrel-bench/issues/55)) ([#59](https://github.com/dsj1984/mandrel-bench/issues/59)) ([e1a7c40](https://github.com/dsj1984/mandrel-bench/commit/e1a7c40f0aa493c02a899e5e88fd4c37cfb93c44))

## [0.4.0](https://github.com/dsj1984/mandrel-bench/compare/mandrel-bench-v0.3.0...mandrel-bench-v0.4.0) (2026-06-19)


### Added

* **agents:** add durable /benchmark workflow under .agents/local ([#45](https://github.com/dsj1984/mandrel-bench/issues/45)) ([c43ee5f](https://github.com/dsj1984/mandrel-bench/commit/c43ee5fc54a3395891546a768d0bb372e2528e37))
* **bench:** instrument the standalone path so its value dims are measured ([#48](https://github.com/dsj1984/mandrel-bench/issues/48)) ([#51](https://github.com/dsj1984/mandrel-bench/issues/51)) ([bd5e517](https://github.com/dsj1984/mandrel-bench/commit/bd5e5171a37b0e34bdb474a26b0effb982e802ea))
* Epic [#32](https://github.com/dsj1984/mandrel-bench/issues/32) ([#43](https://github.com/dsj1984/mandrel-bench/issues/43)) ([955684a](https://github.com/dsj1984/mandrel-bench/commit/955684ac59cd660073822a16e0ea9e1138fc770b))
* project-api as the 1.75.0 Epic rung + first complete 1.75.0 cohort (closes [#50](https://github.com/dsj1984/mandrel-bench/issues/50)) ([#52](https://github.com/dsj1984/mandrel-bench/issues/52)) ([e152ab3](https://github.com/dsj1984/mandrel-bench/commit/e152ab31ab32083cc96f2e8d925c10fad528f900))


### Fixed

* **bench:** skip npm audit without a lockfile; allow project-api scenario ([#49](https://github.com/dsj1984/mandrel-bench/issues/49)) ([57e40b3](https://github.com/dsj1984/mandrel-bench/commit/57e40b3b265845c61c010642f25dcda3b0ae0493))
* **score:** null (not a default) for ledger-derived dims when no ledger ([#47](https://github.com/dsj1984/mandrel-bench/issues/47)) ([c3f4a32](https://github.com/dsj1984/mandrel-bench/commit/c3f4a329ad4d8394e72ef3082f06938aac2fc57d))

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
