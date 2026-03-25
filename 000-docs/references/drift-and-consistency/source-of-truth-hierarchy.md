# Source-of-Truth Hierarchy Standard

## Purpose

Defines the canonical authority order for resolving conflicts between artifacts in a project. When two artifacts disagree, the higher-ranked artifact is correct and the lower-ranked one has drifted.

## Project Type Detection

Before applying a hierarchy, detect the project type by scanning for file markers:

| Marker Files | Project Type |
|-------------|-------------|
| `lib/`, `src/`, `spec/`, `test/`, `Gemfile`, `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `*.gemspec`, `Makefile` | **Engineering repo** |
| `index.html`, `wp-content/`, `themes/`, NO `lib/` or `src/` | **Marketing/content site** |
| Both engineering and content markers present | **Hybrid** |

Detection is additive — check for ANY marker in each category. A single match is sufficient.

## Engineering Repo Hierarchy (Code Is Truth)

| Rank | Artifact | Authority | Rationale |
|------|----------|-----------|-----------|
| 1 | **Code** (implemented behavior) | Highest | What actually runs is what actually matters |
| 2 | **Tests** (verified behavior) | High | Tests assert what code should do — if they pass, the behavior is verified |
| 3 | **CI/Workflows** (automation reality) | High | What CI actually runs is the real validation pipeline |
| 4 | **Canonical docs** (`000-docs/`, `docs/`) | Medium | Current system documentation — should track code closely |
| 5 | **README** | Medium | Public front door — must not overclaim or underclaim |
| 6 | **CLAUDE.md** | Medium | Repo-operational guidance — should reflect actual project state |
| 7 | **Planning docs** (`planning/`, roadmaps) | Low | Future-state unless explicitly marked as implemented |
| 8 | **Beads/task trackers** | Lowest | Execution state — tracks intent, not reality |

### Resolution Rule

When Rank N and Rank M disagree (N < M), Rank N is correct. The finding is filed against the Rank M artifact.

**Example:** If README says "supports PostgreSQL and MySQL" but code only has PostgreSQL adapters, the README has drifted. The code is truth.

## Marketing/Content Site Hierarchy (Website Is Truth)

| Rank | Artifact | Authority |
|------|----------|-----------|
| 1 | **Published website** | Highest |
| 2 | **CMS/content source** | High |
| 3 | **GitHub README** | Medium |
| 4 | **Local docs** | Low |

## Hybrid Hierarchy

Apply engineering hierarchy to code-related artifacts. Apply marketing hierarchy to content-related artifacts. When they overlap (e.g., README describes both code and marketing), engineering hierarchy governs code claims and marketing hierarchy governs content claims.

## Key Principles

1. **Code never lies** — it may be buggy, but it's the actual behavior
2. **Tests are assertions** — passing tests confirm behavior; failing tests indicate known gaps
3. **Docs are claims** — they describe intended or believed behavior, which may have drifted
4. **Planning is aspirational** — roadmap items are NOT features until code implements them
5. **Trackers are process** — task status reflects workflow state, not code state
