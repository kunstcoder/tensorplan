# modelmap data formats

Three JSON files carry a map from the scan to the page. This page is the contract the scripts follow; fields that are not listed here are not part of it. Existing fields never change meaning.

| File | Written by | Read by |
|---|---|---|
| `modelmap/.cache/scan.json` | `scan.mjs` | `describe.mjs`, `build.mjs`, `status.mjs` |
| `modelmap/descriptions/*.json` | you (Claude), checked by `describe.mjs --check` | `build.mjs` |
| `modelmap/graph.json` | `build.mjs` | the page (`index.html`), `serve.mjs`, `query.mjs`, `status.mjs` |

The map folder is `<repo>/modelmap/`. `build.mjs` writes `graph.json`, `index.html`, `query.mjs`, `serve.mjs`, `page-safety.mjs`, `descriptions/` and a `.gitignore` that holds `*`; `open.mjs` writes `index.html`, `query.mjs`, `serve.mjs` and `page-safety.mjs` again from `graph.json` when one of them is not what the plugin writes (the folder can come with a repo); `scan.mjs` writes `.cache/scan.json` there by default.

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
{ version, python, errors[], stats, candidates[], rootClass, root: Node, forward?, dims?, resolution, meta,
  weights?, config? }
```

- `candidates`: the classes that could be the model, `{ name, file, line, hasForward, used, score }`.
- `forward`: the signature of the root's `forward`: `{ file, line, end?, owner, params: [{ name, annotation, default, kwonly?, optional, nullable, docText?, shapeHint? }], returns, doc, output }`. Read from the text of the method, never run.
  - `end`: the last line of the method. `doc`: the docstring, first 600 characters.
  - `optional`: the parameter has a default value (any default), so a caller may leave it out. Nothing else makes it optional.
  - `nullable`: the annotation allows None (`X | None`, `None | X`, `Optional[X]`, `Union[..., None]`, also as a string annotation). A required parameter typed `X | None` is nullable but not optional (AB-UPT's `geometry_batch_idx`: the caller must pass it, possibly as None). No annotation: nullable is false.
  - `docText`: the argument's entry in the docstring (Google style `Args:` with `name (type): text` and indented continuation lines, or simple NumPy style `Parameters` with dashes), at most 400 characters. `shapeHint`: the first dimension list in that entry, as words: `shape (batch_size, seq_len, dim)`, `(B, N, D)`, `[batch, tokens, 3]` give `["batch_size", "seq_len", "dim"]` and so on. Without the word "shape" a list needs two items; lists with type words (Tensor, optional, int, default, ...) are not shapes.
  - `output`: `{ keys[], keysMore?, names?, docText?, shapeHint?, keyDocs?, keyShapes? }`. `keys`: the string keys of the returned dict in the order they first appear in the body (`outputs["a"] = ...` where `outputs` is a local assigned `{}`, a dict literal or `dict()` and returned; `outputs.update(a=...)`, `setdefault`; `return {"a": ...}`, `return dict(a=...)`), duplicates dropped, at most 64 (`keysMore` counts the rest); nested functions do not count. `names`: the names of the first `return a, b` whose elements are plain names. `docText`: the `Returns:` text; `shapeHint`: a dimension list on its first line; `keyDocs`, `keyShapes`: `key: text` lines of the Returns text for keys found in the body.
- `dims`: where the scan saw a name of the dimension table (`lib/contract.mjs`, passed as `dimNames`): `{ args[], attrs[], floordiv[], assigned[] }`. `args`: the root's arguments with such a name, and the fields of a config object given to the root (`via`: the argument), as value records with `name`. `attrs`: module attributes with such a name and an integer value, from the first instance in tree order: `{ name, cls, path, v, at, src?, expr?, set? }` (`at`: the assignment line, or the config line when the value came from a config, then `set` is the assignment line; `expr`: the assigned expression, at most 80 characters). `floordiv`: floor divisions of two such names anywhere in the repo, `{ a, b, at }` (at most 20). `assigned`: assignments to an attribute `head_dim` or `dim_head`, `{ name, at }`.
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

- Only the keys `classes`, `modules`, `contract` and `flows`; class entries only `name`, `d`, `details`; module entries only `d`. All values are strings.
- Caps: `name` 80, `d` 400, `details` 2000 characters. No control characters; line breaks only in `details`.
- The summary of a module is `modules[path].d`, else `classes[cls].d`, else `""`.
- `describe.mjs --check` fails (exit 1) on invalid JSON or a wrong shape, warns about class names and paths the scan does not know, and lists repo classes without a description.
- How to write them: [writing-descriptions.md](writing-descriptions.md).

### The `contract` block (optional): estimated shapes

```json
{
  "contract": {
    "inputs": { "<forward() argument name>": { "shape": "[B, N, 3]", "d": "<text>" } },
    "output": { "d": "<text>", "shape": "[B, N, D]", "keys": { "<returned dict key>": { "shape": "[B, N, 1]", "d": "<text>" } } }
  }
}
```

- Write a shape only when the code makes it clear; otherwise leave it out. Never write a number that is not in the dims table or the code.
- A shape: at most 40 characters, a bracketed list (brackets may nest) of the symbols of the dims table, `B` (batch), `N` (tokens), `B` or `N` with a subscript (`N_s`), integers and `...`. `d`: at most 400 characters, no control characters.
- Files merge field by field; a later file wins. A shape from here is shown with the tag `estimate`; it fills an unknown shape and never replaces a shape from the docstring.
- `describe.mjs --check` fails on a bad shape, an unknown key, a `d` over 400 characters or a control character, and warns about argument and key names that forward() does not have. `build.mjs` drops what does not pass and prints a NOTE for each.

### The `flows` block (optional): how data moves through a block

```json
{
  "flows": {
    "<ClassName, or file.py:ClassName>": {
      "ops": [ { "id": "add1", "op": "add", "label": "+" } ],
      "edges": [ { "from": "norm1", "to": "attn", "shape": "[B, N, D]", "skip": false, "at": "src/block.py:35", "d": "<short note>" } ]
    }
  }
}
```

- The key names the class whose `forward()` the flow describes; it applies to every instance of that class. `"file.py:ClassName"` picks one class when several share the name, and beats a plain `"ClassName"` key for that class. Files merge per class key, field by field (`ops`, `edges`); a later file wins.
- An endpoint (`from`, `to`) is the attribute name of a DIRECT child module of the class (`"self.out"` names a child called `out`), `"in"` (what forward receives; never a `to`), `"out"` (what forward returns; never a `from`), or the `id` of an op.
- An op is an operation that is not a module: `op` is `add`, `mul`, `concat` or `other`; `id` letters, digits and `_` (at most 40, not `in`, `out` or a child's name); `label` at most 20 characters (default `+`, `×`, `⧺`, or the op word).
- `skip: true`: a residual or skip connection (drawn dashed and thinner). `shape`: optional, the grammar of the contract block (dims symbols, `B`, `N` with subscripts, integers, `...`); it is ALWAYS an estimate. `at`: optional `"file:line"`, at most 200 characters, a line inside the class's `forward()` (a line outside it is a warning). `d`: at most 200 characters, no control characters.
- Caps: 40 classes, 12 ops and 60 edges per class; the graph keeps at most 5,000 flow links.
- `describe.mjs --check` fails on an unknown endpoint, a bad shape, an op or edge of the wrong form, caps, lengths and control characters, and warns about a class the scan does not have and an `at` outside `forward()`. `build.mjs` drops what does not pass (a bad shape drops only the shape; the edge stays), prints a NOTE for each and keeps the first 10 in `meta.flowWarnings`.

## graph.json

It keeps floorplan's top-level shape, so the page keeps working:

```
{ schema: "modelmap/graph@1",
  meta: { generatedAt, rootName, root, agent: "claude", counts: { modules, params, unknownParts, contractInputs, flowClasses, linkCount }, flowWarnings? },
  project: { name, summary },
  nodes: GraphNode[], files: [], routes: [], links: [], flows: [], tour: [], contract? }
```

`meta.counts.contractInputs`: the number of inputs of the root's forward(), 0 when there is no contract. `meta.counts.flowClasses`: the number of flows (class keys) that reached the graph; `meta.counts.linkCount`: the number of links. `meta.counts.modules` counts module instances only, never the virtual nodes of a flow. `meta.flowWarnings`: at most 10 lines on what the build dropped from the `flows` block; absent when nothing was dropped. A graph without flows has `links: []` and the same nodes as before flows existed.

### contract

The input and output contract of the root's `forward()` (`lib/contract.mjs`). Absent when the scan found no `forward`.

```
contract: {
  forward: { file, line, owner },
  inputs: [ { name, type: string|null, default: string|null, optional: boolean, nullable: boolean, doc: string|null, shape: Shape, d? } ],
  output: { type: string|null, doc: string|null, keys: [ { name, shape?: Shape, d? } ], keysMore?, names?: string[], shape?: Shape, d? },
  dims: [ { sym, name, value: number|null, src: "code"|"config", at?: "file:line", expr?, why? } ]
}
Shape: { v: string|null, src: "doc"|"estimate", why? }
```

- `type`, `default`: the annotation and the default as written in the code. `optional` (has a default) and `nullable` (the type allows None) as in scan.json; the page marks only `optional` ("opt"). `doc`: the docstring entry of the argument (or the Returns text), cut at 200 characters. `d`: an estimate's text, cut at 400. Caps: name 80, type 120, default 80. Every string is repo text or Claude's text: data, escaped by the page.
- A shape string uses symbols from `dims`, `B`, `N` (with subscripts), integers, commas and brackets only: `"[B, N, 3]"`. Unknown is `v: null` (the page shows `?` and `why`), never `"?"`. `src: "doc"`: from the docstring of forward (words mapped to symbols: batch, batch_size, bs, b → B; seq, seqlen, seq_len, sequence_length, num_tokens, tokens, n, length → N; the names of the table → their symbol; a word that maps to nothing leaves the shape unknown). `src: "estimate"`: Claude wrote it from reading forward, in descriptions/*.json.
- `dims`: the FIXED table, by argument or attribute name: dim, hidden_dim, hidden_size, d_model, embed_dim, n_embd → `D`; num_heads, n_head, n_heads, heads → `H`; head_dim, dim_head → `d_h`; depth, n_layer, num_layers, num_blocks → `L`; vocab_size → `V`; block_size, max_seq_len, max_len → `T`; num_classes → `C`; in_channels → `C_in`; patch_size → `P`; image_size → `S`. An entry exists only when the root's arguments (or the fields of its config) or a module attribute have that name and a number; root arguments come first, then attributes in tree order. Other names for the same symbol with the same value are listed in `expr` (`"also: hidden_dim"`), other values in `why`. An attribute's `expr` is the expression assigned (`"dim // num_heads"`).
- Derived `d_h`: `D // H` only when no head_dim value was found, `D` and `H` exist, and the code divides a D name by an H name (`floordiv`) or assigns an attribute `head_dim`; `name` is that attribute or the division, `expr` the division, `at` where the code does it. No other dimension is computed.

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
| `kind` | `"model"`, `"block"`, `"attention"`, `"mlp"`, `"norm"`, `"embed"`, `"linear"`, `"other"`, `"external"`; for a virtual node `"io"` or `"op"` |
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

### links: the tensor flow inside a block

Every flow of the `flows` block becomes links between the nodes of every instance of its class in the graph. A folded run is one node (its first member), so its flow is drawn once; an unfolded run draws it for each instance.

```
{ a: "n:<node id>", b: "n:<node id>", k: "tensor", w: 1, shape: { v: "[B, N, D]" | null, src: "estimate" }, skip?: true, at?: "file:line", d?: string }
```

The endpoints `in`, `out` and the ops are VIRTUAL nodes, children of the block: `{ id: "<block id>#in" | "<block id>#out" | "<block id>#<op id>", parent: "<block id>", label: "in" | "out" | "<op label>", kind: "io" | "op", summary, details: "", tags: [], paths: [], packages: [], hosts: [], stats: { files: 0, loc: 0 }, virtual: true, io?: "in" | "out", op?: { id, op } }`, with no `m` field. They are not modules: `meta.counts.modules`, the parameter sums, folding, search, the tour and `query.mjs` (find, overview, the children of show, the params breakdowns) leave them out. `query.mjs flow <id>` lists a block's links; every shape there is an estimate.
