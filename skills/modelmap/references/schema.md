# modelmap data formats

Three JSON files carry a map from the scan to the page. This page is the contract the scripts follow; fields that are not listed here are not part of it. Existing fields never change meaning.

| File | Written by | Read by |
|---|---|---|
| `modelmap/.cache/scan.json` | `scan.mjs` | `describe.mjs`, `build.mjs`, `status.mjs` |
| `modelmap/descriptions/*.json` | you (Claude), checked by `describe.mjs --check` | `build.mjs` |
| `modelmap/graph.json` | `build.mjs` | the page (`index.html`), `serve.mjs`, `query.mjs`, `status.mjs` |

The map folder is `<repo>/modelmap/`. `build.mjs` writes `graph.json`, `index.html`, `query.mjs`, `serve.mjs`, `page-safety.mjs`, `descriptions/` and a `.gitignore` that holds `*`; `scan.mjs` writes `.cache/scan.json` there by default.

## Value records

Every value the scan read is a record `{ v, at?, src? }`: `at` is `file:line` where it was read, `src` is `"config"` when it came from a config file (absent means `"code"`). `v` is one of:

| `v` | meaning |
|---|---|
| number, string, boolean, null, array | a plain value |
| `{ "unknown": reason }` | the scan could not know it; `reason` says why |
| `{ "class": name }` | a class passed as a value (e.g. `attn_ctor=Attn`) |
| `{ "ref": name }` | a name the scan kept without resolving |
| `{ "tensor": shape }` | a tensor of that shape |

## scan.json

```
{ version, python, errors[], stats, candidates[], rootClass, root: Node, forward?, resolution, meta,
  weights?, config? }
```

- `candidates`: the classes that could be the model, `{ name, file, line, hasForward, used, score }`.
- `forward`: the signature of the root's `forward`: `{ file, line, owner, params: [{ name, annotation, default }], returns, doc }`.
- `resolution`: counts of the tree (`modules`, `shared`, `reasons[]` of unknown parts).
- `meta`: `{ generatedAt, root, files, via, truncated }`.
- `weights?` (from `--weights`): `{ files[], tensors, totalParams, bytes, unmatchedKeys, unmatchedSample[<=5] }`.
- `config?` (from `--config`): `{ file, arg, key? }`.

### Node

```
{ name, path, cls, kind, file?, line?, args?, pos?, kw?, fq?, why?, container?, params?, baseLayer?,
  tied?, notes?, incomplete?, weights?, check?, children: Node[] }
```

| field | meaning |
|---|---|
| `name` | the attribute name (`attn`, `0`) |
| `path` | the instance path (`blocks.0.attn`); `""` for the root |
| `cls` | the class name |
| `kind` | `"repo"` (defined in the repo), `"torch"`, `"external"` (a package outside the repo), `"unknown"` |
| `file`, `line` | where the class is defined (repo classes) or created |
| `args` | repo classes: constructor arguments, `{ param: value record }` |
| `pos`, `kw` | torch and external classes: the raw call values, as value records |
| `fq` | the fully qualified name, when known |
| `why` | why the module is unknown or external |
| `container` | `"list"`, `"seq"` or `"dict"` for ModuleList, Sequential, ModuleDict |
| `params` | before `annotate()`: direct `nn.Parameter`s, `[{ name, shape }]` |
| `tied` | shared weights, `{ weight\|bias: path }` |
| `weights?` | from a weights file: `{ params, bytes, dtypes: { F32: n, ... }, keys }` |
| `check?` | code against weights: `{ ok, file, expectedKeys, foundKeys, missing[<=5], mismatched[<=5 of { key, expected, found }], codeParams, weightParams }` |

A module shared under a second path is a stub: `{ name, path, cls, kind, alias: "<first path>" }`; its parameters count once, at the first path.

After `annotate()` (scan.mjs runs it) every node also has `params: { v, src, lowerBound?, why? }`, `own` (its direct parameters) and `bytes: { fp32 }`. `lowerBound: true` means the sum holds an unknown part (the map shows `≥`); `why` says which. `params.src` is the weakest source of its parts, in the order `code < config < weights < run`.

## descriptions/*.json

Every `*.json` file in `modelmap/descriptions/` is read, in file-name order; for the same key a later file wins.

```json
{
  "classes": {
    "<ClassName>": { "name": "<short Korean name, English term in brackets>", "d": "<one or two sentences>", "details": "<optional longer text>" }
  },
  "modules": {
    "<instance path>": { "d": "<text>" }
  }
}
```

- Only the keys `classes` and `modules`; class entries only `name`, `d`, `details`; module entries only `d`. All values are strings.
- Caps: `name` 80, `d` 400, `details` 2000 characters. No control characters; line breaks only in `details`.
- The summary of a module is `modules[path].d`, else `classes[cls].d`, else `""`.
- `describe.mjs --check` fails (exit 1) on invalid JSON or a wrong shape, warns about class names and paths the scan does not know, and lists repo classes without a description.
- How to write them: [writing-descriptions.md](writing-descriptions.md).

## graph.json

It keeps floorplan's top-level shape, so the page keeps working:

```
{ schema: "modelmap/graph@1",
  meta: { generatedAt, rootName, root, agent: "claude", counts: { modules, params, unknownParts } },
  project: { name, summary },
  nodes: GraphNode[], files: [], routes: [], links: [], flows: [], tour: [] }
```

### GraphNode

```
{ id, parent, label, kind, summary, details, tags: [], paths: [], packages: [], hosts: [],
  stats: { files: 0, loc: 0 }, m: ModuleRec }
```

| field | meaning |
|---|---|
| `id` | the instance path; the root's id is `"root"` |
| `parent` | the parent's id, or null for the root |
| `label` | the attribute name; for the root, the class name |
| `kind` | `"model"`, `"block"`, `"attention"`, `"mlp"`, `"norm"`, `"embed"`, `"linear"`, `"other"`, `"external"` |
| `summary`, `details` | from descriptions (see above) |

### ModuleRec (the `m` field)

```
{ cls, ckind, def, args, params, own, bytes: { fp32 }, container?, fold?, letter?, pattern?, alias?,
  tied?, notes?, weights?, check? }
```

| field | meaning |
|---|---|
| `cls` | the class name |
| `ckind` | the scan's `kind`: `"repo"`, `"torch"`, `"external"`, `"unknown"` |
| `def` | `{ file, line }` of the definition, or null |
| `args` | `{ name: { v, at?, src? } }` |
| `params` | `{ v, src, lowerBound?, why? }` as in scan.json |
| `own`, `bytes` | as in scan.json |
| `fold` | equal siblings folded into one card: `{ n, members[], total? }` |
| `letter`, `pattern` | siblings that differ: each gets a letter in order of first use, the container shows the pattern (`A B C B C B`) |
| `alias`, `tied`, `notes`, `weights`, `check` | as in scan.json |
