# tools

Documentation style checkers.\
These hold the repository's markdown to the rules published in [apnex/mission-kit](https://github.com/apnex/mission-kit/tree/main/style).

The per-rule tools are vendored rather than fetched, so a fresh clone validates itself with no network and no configuration.\
Each tool owns exactly one rule; `check-docs.sh` only sequences them.

| Tool | Rule | Fix mode |
|---|---|---|
| `s6-one-sentence-per-line.mjs` | S6 one sentence per line | yes |
| `s8-code-block-comments.sh` | S8 code-block comments say what the line does | no, needs judgement |
| `s10-section-rules.sh` | S10 horizontal rule between top-level sections | yes |
| `s12-code-block-introducer.sh` | S12 code-block introducer is its own paragraph | yes |
| `s13-plain-ascii.sh` | S13 plain ASCII only | yes |
| `check-docs.sh` | orchestrator over every markdown file git would keep | delegates |
| `format-markdown.sh` | applies every available fix mode | n/a |
| `lib/style-common.sh` | shared exemption handling and finding format | n/a |

---

## Usage

Check every markdown file, tracked or not:
```bash
npm run docs:check
```

Apply every mechanical fix, then re-check:
```bash
npm run docs:fix
```

Check named files only:
```bash
tools/check-docs.sh README.md docs/TESTING.md
```

Every checker runs even when an earlier one fails, so one invocation reports everything rather than the first thing.

The default file set is tracked *and* untracked files, honouring `.gitignore`.\
Checking only tracked files reported clean over documents it had never opened, so a new file passed locally and failed in continuous integration the moment it was added.

---

## Exemptions

A file opts out of one rule with a marker on its own line, which keeps the exemption explicit and greppable:
```markdown
<!-- style-check: allow S13 (the character is the subject of this document) -->
```

An exemption states its reason.\
A marker with no justification is a defect.

---

## Updating

These tools are copies.\
Improve the rule upstream in `mission-kit`, then re-copy the changed tool here, so one definition of a rule exists and the two cannot drift into disagreement.
