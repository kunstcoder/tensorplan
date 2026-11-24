#!/usr/bin/env python3
# modelmap pyscan.py: read Python source as TEXT and build the module tree of a PyTorch model.
#
# It never imports, executes or compiles the code it reads. It only calls ast.parse (text to tree) and
# runs a small interpreter over that tree: loops, if on known values, defaults, constructor calls.
# Anything it cannot know stays unknown, with a reason. It never guesses a value.
#
# Input : one JSON job on stdin   {"root": "<abs dir>", "files": ["rel/a.py", ...], "rootClass": null, "args": {},
#          "config": null | {"data": ..., "lines": ..., "file": "cfg.yaml", "arg": null | "config" | "**"}}
# Output: one JSON document on stdout
#
# Source tags: a number or string that came from a config file or from --arg is a tainted value (CInt, CFloat,
# CStr: subclasses of int, float and str that carry "at", "file:line" or "command line"). They behave as plain
# values everywhere (range, indexing, comparisons, dict keys) and arithmetic keeps the tag: the result of an
# operation with a tainted operand is tainted with the at of the first tainted operand. rec() writes
# src: "config" and that at on the value record. Containers stay plain; their elements are tainted.
# bool cannot be subclassed, so bool values (and None) are NOT tracked: they carry no source.
import ast
import json
import os
import re
import sys

try:
    import resource
except ImportError:   # Windows has no resource module: the memory backstop in tick() is then skipped
    resource = None

if sys.version_info < (3, 9):
    sys.stdout.write(json.dumps({"fatal": "Python 3.9 or newer is needed to read the code (ast.unparse)."}))
    sys.exit(0)

sys.setrecursionlimit(6000)
MAX_STEPS = 600000          # statements and expressions for one scan
MAX_LOOP = 4096             # iterations of one loop or comprehension
MAX_DEPTH = 24              # nesting of constructor calls
MAX_FILE_BYTES = 2 * 1024 * 1024
# What one operation may build. Each is checked BEFORE the operation runs, from the sizes of its operands (see
# binop_refusal); a result above them is unknown ("value too large") and is never computed.
MAX_SEQ = 100000            # the longest str, list or tuple (this was the limit of sequence * int)
MAX_BITS = 1024             # the widest int: real values stay far below 2**64
MAX_NODES = 10000           # elements of one nested value that str() and the JSON output expand (a shared element counts each time)
# The backstop in tick(): the peak memory of this process. The per-operation limits above are the real protection; this
# stops what they cannot see (many values that are each small enough). MODELMAP_PYSCAN_MAX_RSS_MB is for the tests: it
# can only LOWER the limit, a value above it or one that is not a number changes nothing.
MAX_RSS = 1536 * 1024 * 1024
try:
    if 0 < float(os.environ.get("MODELMAP_PYSCAN_MAX_RSS_MB", "")) * 1048576 < MAX_RSS:
        MAX_RSS = int(float(os.environ["MODELMAP_PYSCAN_MAX_RSS_MB"]) * 1048576)
except ValueError:
    pass
TOO_LARGE = "value too large"
THIRD_PARTY = {
    "torch", "torchvision", "torchaudio", "timm", "transformers", "einops", "numpy", "math", "functools",
    "collections", "typing", "dataclasses", "os", "sys", "re", "json", "scipy", "pandas", "jax", "flax",
    "tensorflow", "torch_geometric", "torch_scatter", "pytorch_lightning", "lightning", "omegaconf", "hydra",
    "yaml", "abc", "enum", "itertools", "copy", "warnings", "logging", "pathlib", "diffusers", "peft",
}
NO_LAYER_NS = (".functional", ".init", ".utils", ".parallel", ".modules.utils")
LOOKS_LIKE_MODULE = ("ctor", "cls", "class", "layer", "block", "module", "norm", "act", "attn", "head")


def _taint_at(*vals):
    for v in vals:
        if isinstance(v, (CInt, CFloat, CStr)):
            return v.at
    return None


def taint(r, at):
    """Wrap a plain result so that it carries at. bool, None and other values stay as they are."""
    if at is None or isinstance(r, bool) or isinstance(r, (CInt, CFloat, CStr)):
        return r
    if type(r) is int:
        return CInt(r, at)
    if type(r) is float:
        return CFloat(r, at)
    if type(r) is str:
        return CStr(r, at)
    if type(r) is tuple:
        return tuple(taint(x, at) for x in r)
    return r


def _ops(names):
    def make(name, reflected):
        def op(self, *other):
            r = getattr(self._base, name)(self, *other)
            if r is NotImplemented and self._base is int and other and type(plain(other[0])) is float and hasattr(float, name):
                r = getattr(float, name)(float(int.__int__(self)), plain(other[0]))   # 3 * 1.5 keeps the tag
            if r is NotImplemented:
                return r
            # the left operand comes first: in a reflected call it is the other value
            first = (_taint_at(other[0]) if reflected and other else None) or self.at
            return taint(r, first)
        return op

    def deco(cls):
        for nm in names:
            if hasattr(cls._base, nm):
                setattr(cls, nm, make(nm, nm.startswith("__r") and nm not in ("__round__", "__rshift__")))
        return cls
    return deco


_NUM_OPS = ["__add__", "__radd__", "__sub__", "__rsub__", "__mul__", "__rmul__", "__truediv__", "__rtruediv__",
            "__floordiv__", "__rfloordiv__", "__mod__", "__rmod__", "__pow__", "__rpow__", "__divmod__", "__rdivmod__",
            "__lshift__", "__rlshift__", "__rshift__", "__rrshift__", "__and__", "__rand__", "__or__", "__ror__",
            "__xor__", "__rxor__", "__neg__", "__pos__", "__abs__", "__invert__", "__round__", "__trunc__",
            "__floor__", "__ceil__"]


@_ops(_NUM_OPS)
class CInt(int):
    _base = int

    def __new__(cls, v, at):
        o = int.__new__(cls, v)
        o.at = at
        return o


@_ops(_NUM_OPS)
class CFloat(float):
    _base = float

    def __new__(cls, v, at):
        o = float.__new__(cls, v)
        o.at = at
        return o


@_ops(["__add__", "__mul__", "__rmul__", "__mod__", "__rmod__"])
class CStr(str):
    _base = str

    def __new__(cls, v, at):
        o = str.__new__(cls, v)
        o.at = at
        return o

    def __radd__(self, other):
        r = str.__add__(other, self) if isinstance(other, str) else NotImplemented
        return r if r is NotImplemented else taint(r, _taint_at(other) or self.at)


def plain(v):
    """The plain value of a tainted one (for JSON output)."""
    if isinstance(v, bool):
        return v
    if isinstance(v, CInt):
        return int.__int__(v)
    if isinstance(v, CFloat):
        return float.__float__(v)
    if isinstance(v, CStr):
        return str.__str__(v)
    return v


def plain_type(v):
    return type(plain(v))


def taint_tree(v, lines, at_of, depth=0):
    """Tag every number and string leaf of a config value. lines mirrors v (see lib/yaml.mjs) or is None."""
    if depth > 40:
        return v
    if isinstance(v, dict):
        return {k: taint_tree(x, lines.get(k) if isinstance(lines, dict) else None, at_of, depth + 1) for k, x in v.items()}
    if isinstance(v, list):
        return [taint_tree(x, lines[i] if isinstance(lines, list) and i < len(lines) else None, at_of, depth + 1) for i, x in enumerate(v)]
    return taint(v, at_of(lines))


class Unk:
    __slots__ = ("why",)

    def __init__(self, why):
        self.why = str(why)


class Ref:
    """A dotted name that came from an import, for example torch.nn.Linear."""
    __slots__ = ("fq",)

    def __init__(self, fq):
        self.fq = fq


class Builtin:
    __slots__ = ("name",)

    def __init__(self, name):
        self.name = name


class Cls:
    __slots__ = ("info",)

    def __init__(self, info):
        self.info = info


class Partial:
    __slots__ = ("target", "args", "kwargs")

    def __init__(self, target, args, kwargs):
        self.target, self.args, self.kwargs = target, args, kwargs


class FuncV:
    __slots__ = ("node", "fi")

    def __init__(self, node, fi):
        self.node, self.fi = node, fi


class BoundMethod:
    __slots__ = ("mod", "name", "fn", "owner")

    def __init__(self, mod, name, fn, owner):
        self.mod, self.name, self.fn, self.owner = mod, name, fn, owner


class TensorV:
    __slots__ = ("shape",)

    def __init__(self, shape):
        self.shape = shape


class ParamV:
    __slots__ = ("shape",)

    def __init__(self, shape):
        self.shape = shape


class PRef:
    """The weight or bias of a torch layer, as a value: used to see that two layers share one weight."""
    __slots__ = ("mod", "name")

    def __init__(self, mod, name):
        self.mod, self.name = mod, name


class Halt(Exception):
    pass


class Ret(Exception):
    def __init__(self, value):
        self.value = value


class Brk(Exception):
    pass


class Cnt(Exception):
    pass


class Budget(Exception):
    pass   # str(e) says what ran out; empty means the step budget


class Mod:
    _n = 0

    def __init__(self, kind, cls, file=None, line=None, info=None):
        Mod._n += 1
        self.id = Mod._n
        self.kind = kind            # repo | torch | external | unknown
        self.cls = cls
        self.file, self.line, self.info = file, line, info
        self.args = {}              # repo classes: parameter name -> (value, at)
        self.pos, self.kw = [], {}  # torch and external classes: raw call values -> (value, at)
        self.children = []          # [name, Mod]
        self.attrs = {}             # everything assigned to self.<name>
        self.params = []            # direct nn.Parameter: [name, shape]
        self.notes = []
        self.incomplete = False
        self.container = None      # list | seq | dict
        self.base_layer = None     # a class that extends a torch layer: (name, pos, kw)
        self.tied = {}             # weight or bias -> the Mod whose weight this layer shares
        self.attr_at = {}          # attributes with a dimension name: name -> (file:line of the assignment, its text)
        self.why = None
        self.fq = None
        self.by_name = {}           # name -> its [name, Mod] entry in children (a list of 100,000 modules must not take a scan per add)

    def set_child(self, name, child):
        c = self.by_name.get(name)
        if c is not None:
            c[1] = child
            return
        c = [name, child]
        self.children.append(c)
        self.by_name[name] = c

    def child(self, name):
        c = self.by_name.get(name)
        return c[1] if c is not None else None


class Frame:
    __slots__ = ("fi", "locals", "mod", "owner", "depth")

    def __init__(self, fi, locals_=None, mod=None, owner=None, depth=0):
        self.fi, self.locals, self.mod, self.owner, self.depth = fi, locals_ if locals_ is not None else {}, mod, owner, depth

    def sub(self):
        return Frame(self.fi, dict(self.locals), self.mod, self.owner, self.depth)


def dotted(n):
    parts = []
    while isinstance(n, ast.Attribute):
        parts.append(n.attr)
        n = n.value
    if isinstance(n, ast.Name):
        parts.append(n.id)
        return ".".join(reversed(parts))
    return None


def last_name(n):
    if isinstance(n, ast.Name):
        return n.id
    if isinstance(n, ast.Attribute):
        return n.attr
    return ""


class ClassInfo:
    def __init__(self, fi, node):
        self.fi, self.node, self.name, self.line = fi, node, node.name, node.lineno
        self.methods = {n.name: n for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}


class FileInfo:
    def __init__(self, path, tree):
        self.path, self.tree = path, tree
        self.imports, self.consts, self.classes, self.funcs, self.const_cache = {}, {}, {}, {}, {}
        for n in tree.body:
            self.top(n)

    def top(self, n):
        if isinstance(n, ast.Import):
            for a in n.names:
                if a.asname:
                    self.imports[a.asname] = a.name
                else:
                    root = a.name.split(".")[0]
                    self.imports[root] = root
        elif isinstance(n, ast.ImportFrom):
            base = ("." * n.level) + (n.module or "")
            for a in n.names:
                if a.name == "*":
                    continue
                joiner = "" if base.endswith(".") or not base else "."
                self.imports[a.asname or a.name] = base + joiner + a.name
        elif isinstance(n, ast.ClassDef):
            self.classes[n.name] = ClassInfo(self, n)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self.funcs[n.name] = n
        elif isinstance(n, ast.Assign):
            for t in n.targets:
                if isinstance(t, ast.Name):
                    self.consts[t.id] = n.value
        elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.value is not None:
            self.consts[n.target.id] = n.value
        elif isinstance(n, ast.Try):
            for b in n.body + [x for h in n.handlers for x in h.body] + n.orelse:
                self.top(b)
        elif isinstance(n, ast.If):
            for b in n.body + n.orelse:
                self.top(b)


BUILTIN_NAMES = {"range", "len", "int", "float", "str", "bool", "min", "max", "sum", "abs", "round", "list", "tuple",
                 "dict", "enumerate", "zip", "sorted", "reversed", "any", "all", "pow", "print", "isinstance",
                 "getattr", "hasattr", "type", "super", "set", "map", "filter", "divmod", "ord", "chr"}


def max_rss():
    """The peak memory of this process in bytes (macOS counts bytes, Linux kilobytes), or 0 when it cannot be read."""
    if resource is None:
        return 0
    try:
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    except Exception:
        return 0
    return peak if sys.platform == "darwin" else peak * 1024


class TooLarge(Exception):
    """An operation would build more than MAX_SEQ or MAX_BITS allow. ev() turns it into an unknown value."""


def range_len(r):
    """len(r) that also works for a range longer than the machine's int (len() raises OverflowError for it)."""
    step = r.step
    return max((r.stop - r.start + (step - 1 if step > 0 else step + 1)) // step, 0)


def seq_len(v):
    """The length of a range, str, list, tuple or dict, or None for any other value."""
    if isinstance(v, range):
        return range_len(v)
    return len(v) if isinstance(v, (str, list, tuple, dict)) else None


def small(v, limit=MAX_NODES):
    """True when the nested value v holds at most limit elements in all, an element that is shared counted each time."""
    total, stack = 1, [v]
    while stack:
        x = stack.pop()
        if isinstance(x, (list, tuple)):
            total += len(x)
            if total > limit:
                return False
            stack.extend(x)
        elif isinstance(x, dict):
            total += 2 * len(x)
            if total > limit:
                return False
            stack.extend(x.keys())
            stack.extend(x.values())
    return True


_SPEC = re.compile(r"%(?:\([^)]*\))?[#0 +\-]*(\*|\d*)(?:\.(\*|\d*))?")


def format_refusal(fmt, arg):
    """True when fmt % arg could build more than MAX_SEQ characters: a width or precision above 999 or a *, or too much text."""
    total = len(fmt)
    args = list(arg) if isinstance(arg, tuple) else list(arg.values()) if isinstance(arg, dict) else [arg]
    longest = 0
    for x in args:
        if isinstance(x, str):
            longest = max(longest, len(x))
        elif x is None or isinstance(x, (int, float)):
            longest = max(longest, 400)
        else:
            return True   # a list or the like: how long its text is, is not worked out here
    for m in _SPEC.finditer(fmt):
        width, prec = m.group(1), m.group(2)
        if "*" in (width, prec) or int(width or 0) > 999 or int(prec or 0) > 999:
            return True
        total += max(int(width or 0), int(prec or 0), longest)
    return total > MAX_SEQ


def binop_refusal(op, a, b):
    """Why 'a op b' is not computed (too large), or None. The size of the result is worked out from the sizes of the operands
    first: an int's bit length, a sequence's length. a and b are ints (bool and the tainted CInt too), floats, strs, lists or tuples."""
    a_int, b_int = isinstance(a, int), isinstance(b, int)
    a_seq, b_seq = isinstance(a, (list, tuple, str)), isinstance(b, (list, tuple, str))
    if op is ast.Add and a_seq and b_seq:
        return TOO_LARGE if len(a) + len(b) > MAX_SEQ else None
    if op is ast.Mult and a_seq and b_int:
        return TOO_LARGE if len(a) * max(b, 0) > MAX_SEQ else None
    if op is ast.Mult and a_int and b_seq:
        return TOO_LARGE if max(a, 0) * len(b) > MAX_SEQ else None
    if op is ast.Mod and isinstance(a, str):
        return TOO_LARGE if format_refusal(a, b) else None
    if a_int and b_int:
        bits_a, bits_b = int.bit_length(a), int.bit_length(b)
        if op in (ast.Add, ast.Sub):
            too = max(bits_a, bits_b) + 1 > MAX_BITS
        elif op is ast.Mult:
            too = bits_a + bits_b > MAX_BITS
        elif op is ast.Pow:
            too = b > 0 and bits_a > 1 and bits_a * b > MAX_BITS   # 0, 1 and -1 stay small to any power; a negative power is a float
        elif op is ast.LShift:
            too = b > 0 and bits_a > 0 and bits_a + b > MAX_BITS
        else:
            too = False
        return TOO_LARGE if too else None
    return None


def truth(v):
    if isinstance(v, Unk):
        return None
    if isinstance(v, (Mod, Cls, Ref, Builtin, Partial, FuncV, BoundMethod, TensorV, ParamV)):
        return True
    try:
        return bool(v)
    except Exception:
        return None


class Interp:
    def __init__(self):
        self.files = {}
        self.by_name = {}
        self.steps = 0
        self.warnings = []
        self._mro = {}
        self.dim_names = frozenset()  # attribute names whose assignment line and text are kept (job "dimNames")

    # ---------- index ----------
    def add(self, path, text):
        tree = ast.parse(text, filename=path)
        fi = FileInfo(path, tree)
        self.files[path] = fi
        for c in fi.classes.values():
            self.by_name.setdefault(c.name, []).append(c)

    def tick(self):
        self.steps += 1
        if self.steps > MAX_STEPS:
            raise Budget()
        # every 2048 steps: the peak memory so far (a backstop; see MAX_RSS)
        if self.steps % 2048 == 0 and max_rss() > MAX_RSS:
            raise Budget("memory limit exceeded")

    def pick_class(self, name, fq=None, fi=None):
        if ":" in name and fi is None and fq is None:
            spec, _, name = name.rpartition(":")
            hit = [c for c in self.by_name.get(name, []) if c.fi.path == spec or c.fi.path.endswith("/" + spec)]
            return hit[0] if hit else None
        cands = self.by_name.get(name) or []
        if not cands:
            return None
        if fi is not None:
            for c in cands:
                if c.fi is fi:
                    return c
        if fq and len(cands) > 1:
            mod = fq.rsplit(".", 1)[0].lstrip(".").replace(".", "/")
            for c in cands:
                if mod and (c.fi.path[:-3].endswith(mod) or c.fi.path.endswith(mod + "/__init__.py")):
                    return c
        return cands[0]

    def base_of(self, expr, fi):
        """Resolve one base class expression: ('repo', info) | ('torch', fq) | ('ext', fq) | None."""
        d = dotted(expr)
        if d is None:
            return None
        head, _, rest = d.partition(".")
        if not rest and head in fi.classes:
            return ("repo", fi.classes[head])
        fq = fi.imports.get(head)
        full = (fq + ("." + rest if rest else "")) if fq else d
        root = full.split(".")[0]
        last = full.rsplit(".", 1)[-1]
        if full.startswith("torch.nn") or root == "nn":
            return ("torch", full if full.startswith("torch") else "torch." + full)
        if root not in THIRD_PARTY and last in self.by_name:
            return ("repo", self.pick_class(last, full, fi))
        return ("ext", full)

    def mro(self, info):
        if info in self._mro:
            return self._mro[info]
        out = [info]
        self._mro[info] = out
        for b in info.node.bases:
            r = self.base_of(b, info.fi)
            if r and r[0] == "repo" and r[1] is not info:
                for x in self.mro(r[1]):
                    if x not in out:
                        out.append(x)
        return out

    def is_module(self, info, seen=None):
        seen = seen or set()
        if info in seen:
            return False
        seen.add(info)
        for b in info.node.bases:
            r = self.base_of(b, info.fi)
            if not r:
                continue
            if r[0] == "torch":
                return True
            if r[0] == "repo" and self.is_module(r[1], seen):
                return True
        return False

    def find_method(self, info, name):
        for c in self.mro(info):
            if name in c.methods:
                return c.methods[name], c
        return None, None

    # ---------- values ----------
    def const(self, fi, name):
        if name in fi.const_cache:
            return fi.const_cache[name]
        fi.const_cache[name] = Unk("constant " + name + " is being read")
        v = self.ev(fi.consts[name], Frame(fi))
        fi.const_cache[name] = v
        return v

    def ref_value(self, ref, fi):
        fq = ref.fq
        root = fq.split(".")[0]
        last = fq.rsplit(".", 1)[-1]
        if root not in THIRD_PARTY and last[:1].isupper() and last in self.by_name:
            return Cls(self.pick_class(last, fq, fi))
        return ref

    def ev(self, n, fr):
        self.tick()
        m = getattr(self, "ev_" + type(n).__name__, None)
        if m is None:
            return Unk(type(n).__name__ + " is not supported")
        try:
            return m(n, fr)
        except (Halt, Ret, Brk, Cnt, Budget):
            raise
        except TooLarge:
            return Unk(TOO_LARGE)
        except RecursionError:
            return Unk("expression too deep")
        except Exception as e:  # a value that cannot be computed stays unknown
            return Unk(type(e).__name__ + ": " + str(e)[:80])

    def ev_Constant(self, n, fr):
        v = n.value
        if type(v) is int and v.bit_length() > MAX_BITS:   # a literal of hundreds of digits
            return Unk(TOO_LARGE)
        return Unk("Ellipsis") if v is Ellipsis else v

    def ev_Name(self, n, fr):
        k = n.id
        if k in fr.locals:
            return fr.locals[k]
        fi = fr.fi
        if k in fi.classes:
            return Cls(fi.classes[k])
        if k in fi.consts:
            return self.const(fi, k)
        if k in fi.funcs:
            return FuncV(fi.funcs[k], fi)
        fq = fi.imports.get(k)
        if fq is not None:
            return self.ref_value(Ref(fq), fi)
        if k in BUILTIN_NAMES:
            return Builtin(k)
        return Unk("name " + k + " is not known here")

    def ev_Attribute(self, n, fr):
        base = self.ev(n.value, fr)
        if isinstance(base, Ref):
            return self.ref_value(Ref(base.fq + "." + n.attr), fr.fi)
        if isinstance(base, dict):
            # a config object that came from a file or from --arg
            return base[n.attr] if n.attr in base else Unk("the config has no " + n.attr)
        if isinstance(base, Mod):
            if n.attr in base.attrs:
                return base.attrs[n.attr]
            if base.kind == "torch" and n.attr in ("weight", "bias"):
                return PRef(base, n.attr)
            ch = base.child(n.attr)
            if ch is not None:
                return ch
            if base.info is not None:
                fn, owner = self.find_method(base.info, n.attr)
                if fn is not None:
                    return BoundMethod(base, n.attr, fn, owner)
            return Unk("attribute " + n.attr + " is not set")
        if isinstance(base, Unk):
            return Unk(base.why)
        return Unk("attribute " + n.attr + " of a value that is not a module")

    def ev_Tuple(self, n, fr):
        return tuple(self.seq(n.elts, fr))

    def ev_List(self, n, fr):
        return list(self.seq(n.elts, fr))

    def seq(self, elts, fr):
        out = []
        for e in elts:
            if isinstance(e, ast.Starred):
                v = self.ev(e.value, fr)
                items = self.to_seq(v)
                if items is not None and len(out) + len(items) > MAX_SEQ:
                    raise TooLarge()
                out.extend(items if items is not None else [Unk("a * argument that is not known")])
            else:
                out.append(self.ev(e, fr))
        return out

    def ev_Dict(self, n, fr):
        out = {}
        for k, v in zip(n.keys, n.values):
            if k is None:
                d = self.ev(v, fr)
                if isinstance(d, dict):
                    out.update(d)
                continue
            kk = self.ev(k, fr)
            if isinstance(kk, (str, int, float, bool, tuple)):
                out[kk] = self.ev(v, fr)
        return out

    def ev_BinOp(self, n, fr):
        a, b = self.ev(n.left, fr), self.ev(n.right, fr)
        if isinstance(a, Unk):
            return a
        if isinstance(b, Unk):
            return b
        op = type(n.op)
        if op in (ast.Mult,) and isinstance(a, (list, tuple, str)) and isinstance(b, int) and len(a) * max(b, 0) > MAX_SEQ:
            return Unk("sequence too long")
        f = {ast.Add: lambda x, y: x + y, ast.Sub: lambda x, y: x - y, ast.Mult: lambda x, y: x * y,
             ast.Div: lambda x, y: x / y, ast.FloorDiv: lambda x, y: x // y, ast.Mod: lambda x, y: x % y,
             ast.Pow: lambda x, y: x ** y, ast.BitOr: lambda x, y: x | y, ast.BitAnd: lambda x, y: x & y,
             ast.LShift: lambda x, y: x << y, ast.RShift: lambda x, y: x >> y}.get(op)
        if f is None:
            return Unk("operator not supported")
        if isinstance(a, (int, float, str, list, tuple, bool)) and isinstance(b, (int, float, str, list, tuple, bool)):
            if op is ast.Pow and isinstance(b, int) and b > 64:
                return Unk("power too large")
            why = binop_refusal(op, a, b)   # before f(a, b): nothing too large is ever computed
            if why:
                return Unk(why)
            return taint(f(a, b), _taint_at(a, b))
        return Unk("operands are not plain values")

    def ev_UnaryOp(self, n, fr):
        v = self.ev(n.operand, fr)
        if isinstance(v, Unk):
            return v
        if isinstance(n.op, ast.Not):
            t = truth(v)
            return Unk("truth value unknown") if t is None else (not t)
        if isinstance(v, (int, float, bool)):
            return taint({ast.USub: lambda x: -x, ast.UAdd: lambda x: +x, ast.Invert: lambda x: ~x}[type(n.op)](v), _taint_at(v))
        return Unk("unary operator on a non-number")

    def ev_BoolOp(self, n, fr):
        isand = isinstance(n.op, ast.And)
        last = None
        for e in n.values:
            v = self.ev(e, fr)
            t = truth(v)
            if t is None:
                return Unk("condition not known")
            last = v
            if isand and not t:
                return v
            if not isand and t:
                return v
        return last

    def ev_Compare(self, n, fr):
        left = self.ev(n.left, fr)
        for op, rn in zip(n.ops, n.comparators):
            right = self.ev(rn, fr)
            if isinstance(left, Unk) or isinstance(right, Unk):
                return Unk("comparison with an unknown value")
            t = type(op)
            try:
                if t is ast.Eq:
                    ok = left == right
                elif t is ast.NotEq:
                    ok = left != right
                elif t is ast.Lt:
                    ok = left < right
                elif t is ast.LtE:
                    ok = left <= right
                elif t is ast.Gt:
                    ok = left > right
                elif t is ast.GtE:
                    ok = left >= right
                elif t is ast.Is:
                    ok = left is right or (left == right and isinstance(left, (int, str, bool)) and plain_type(left) is plain_type(right))
                elif t is ast.IsNot:
                    ok = not (left is right or (left == right and isinstance(left, (int, str, bool)) and plain_type(left) is plain_type(right)))
                elif t is ast.In:
                    ok = left in right
                elif t is ast.NotIn:
                    ok = left not in right
                else:
                    return Unk("comparison not supported")
            except Exception:
                return Unk("comparison failed")
            if not ok:
                return False
            left = right
        return True

    def ev_IfExp(self, n, fr):
        t = truth(self.ev(n.test, fr))
        if t is None:
            return Unk("condition not known")
        return self.ev(n.body if t else n.orelse, fr)

    def ev_Subscript(self, n, fr):
        base = self.ev(n.value, fr)
        sl = n.slice
        if isinstance(sl, ast.Slice):
            lo = self.ev(sl.lower, fr) if sl.lower else None
            hi = self.ev(sl.upper, fr) if sl.upper else None
            st = self.ev(sl.step, fr) if sl.step else None
            if any(isinstance(x, Unk) for x in (lo, hi, st)):
                return Unk("slice not known")
            idx = slice(lo, hi, st)
        else:
            idx = self.ev(sl, fr)
        if isinstance(base, Unk):
            return base
        if isinstance(idx, Unk):
            return Unk("index not known")
        if isinstance(base, Mod) and base.container in ("list", "seq"):
            if isinstance(idx, int):
                try:
                    return base.children[idx][1]
                except IndexError:
                    return Unk("index out of range")
            return Unk("index of a module list is not an int")
        if isinstance(base, Mod) and base.container == "dict" and isinstance(idx, str):
            c = base.child(idx)
            return c if c is not None else Unk("key not in the module dict")
        if isinstance(base, (list, tuple, str, dict, range)):
            return base[idx]
        return Unk("value cannot be indexed")

    def ev_JoinedStr(self, n, fr):
        out = ""
        at = None
        for p in n.values:
            if isinstance(p, ast.Constant):
                out += str(p.value)
            elif isinstance(p, ast.FormattedValue) and p.format_spec is None and p.conversion in (-1, 115):
                v = self.ev(p.value, fr)
                if isinstance(v, (str, int, float, bool)):
                    at = at or _taint_at(v)
                    out += str(plain(v))
                else:
                    return Unk("f-string with an unknown part")
            else:
                return Unk("f-string with a format spec")
            if len(out) > MAX_SEQ:
                raise TooLarge()
        return taint(out, at)

    def ev_Lambda(self, n, fr):
        return Unk("lambda")

    def ev_Starred(self, n, fr):
        return Unk("star outside a call")

    def comp(self, n, fr, make):
        fr2 = fr.sub()
        out = []

        def go(i):
            if i == len(n.generators):
                if len(out) >= MAX_SEQ:
                    raise Halt("value too large")
                out.append(make(fr2))
                return
            g = n.generators[i]
            seq = self.to_seq(self.ev(g.iter, fr2))
            if seq is None or len(seq) > MAX_LOOP:
                raise Halt("loop not known")
            for item in seq:
                self.bind_target(g.target, item, fr2)
                ok = True
                for c in g.ifs:
                    t = truth(self.ev(c, fr2))
                    if t is None:
                        raise Halt("condition not known")
                    if not t:
                        ok = False
                        break
                if ok:
                    go(i + 1)

        try:
            go(0)
        except Halt as e:
            return Unk("comprehension: " + (str(e) or "not known"))
        return out

    def ev_ListComp(self, n, fr):
        return self.comp(n, fr, lambda f: self.ev(n.elt, f))

    def ev_GeneratorExp(self, n, fr):
        return self.ev_ListComp(n, fr)

    def ev_SetComp(self, n, fr):
        return Unk("set comprehension")

    def ev_DictComp(self, n, fr):
        r = self.comp(n, fr, lambda f: (self.ev(n.key, f), self.ev(n.value, f)))
        if isinstance(r, Unk):
            return r
        return {k: v for k, v in r if isinstance(k, (str, int, float, bool, tuple))}

    # ---------- sequences and targets ----------
    def to_seq(self, v):
        if isinstance(v, (list, tuple, str)):
            return list(v) if len(v) <= MAX_SEQ else None
        if isinstance(v, range):
            return list(v) if range_len(v) <= MAX_LOOP else None
        if isinstance(v, dict):
            return list(v.keys())
        if isinstance(v, Mod) and v.container in ("list", "seq"):
            return [c[1] for c in v.children]
        if isinstance(v, Mod) and v.container == "dict":
            return [c[0] for c in v.children]
        return None

    def bind_target(self, t, v, fr):
        if isinstance(t, ast.Name):
            fr.locals[t.id] = v
        elif isinstance(t, (ast.Tuple, ast.List)):
            items = self.to_seq(v)
            stars = [i for i, e in enumerate(t.elts) if isinstance(e, ast.Starred)]
            if items is not None and not stars and len(items) == len(t.elts):
                for e, x in zip(t.elts, items):
                    self.bind_target(e, x, fr)
            elif items is not None and len(stars) == 1 and len(items) >= len(t.elts) - 1:
                s = stars[0]
                after = len(t.elts) - s - 1
                for e, x in zip(t.elts[:s], items[:s]):
                    self.bind_target(e, x, fr)
                self.bind_target(t.elts[s].value, items[s:len(items) - after], fr)
                for e, x in zip(t.elts[s + 1:], items[len(items) - after:]):
                    self.bind_target(e, x, fr)
            else:
                for e in t.elts:
                    self.bind_target(e.value if isinstance(e, ast.Starred) else e, Unk("unpacking a value that is not known"), fr)

    # ---------- calls ----------
    def eval_args(self, n, fr):
        args, anodes, kwargs, knodes = [], [], {}, {}
        for a in n.args:
            if isinstance(a, ast.Starred):
                items = self.to_seq(self.ev(a.value, fr))
                if items is None:
                    args.append(Unk("a * argument that is not known"))
                    anodes.append(a)
                else:
                    if len(args) + len(items) > MAX_SEQ:
                        raise TooLarge()
                    for x in items:
                        args.append(x)
                        anodes.append(a)
            else:
                args.append(self.ev(a, fr))
                anodes.append(a)
        for k in n.keywords:
            if k.arg is None:
                d = self.ev(k.value, fr)
                if isinstance(d, dict):
                    for kk, vv in d.items():
                        kwargs[str(kk)] = vv
                        knodes[str(kk)] = k.value
            else:
                kwargs[k.arg] = self.ev(k.value, fr)
                knodes[k.arg] = k.value
        return args, anodes, kwargs, knodes

    def at(self, fr, node):
        return fr.fi.path + ":" + str(getattr(node, "lineno", 0))

    def ev_Call(self, n, fr):
        f = n.func
        if isinstance(f, ast.Attribute):
            # super().__init__(...)
            if f.attr == "__init__" and isinstance(f.value, ast.Call) and last_name(f.value.func) == "super":
                return self.super_init(n, fr)
            if f.attr in ("append", "extend", "add_module", "register_module", "insert"):
                return self.mutate(f, n, fr)
            if f.attr in ("register_buffer", "register_parameter", "apply", "to", "eval", "train", "requires_grad_"):
                return None
        callee = self.ev(f, fr)
        args, anodes, kwargs, knodes = self.eval_args(n, fr)
        return self.call(callee, args, anodes, kwargs, knodes, n, fr)

    def call(self, callee, args, anodes, kwargs, knodes, n, fr):
        if isinstance(callee, Cls):
            return self.instantiate(callee.info, args, anodes, kwargs, knodes, n, fr)
        if isinstance(callee, Ref):
            return self.call_ref(callee, args, anodes, kwargs, knodes, n, fr)
        if isinstance(callee, Partial):
            return self.call(callee.target, list(callee.args) + args, [None] * len(callee.args) + anodes,
                             {**callee.kwargs, **kwargs}, knodes, n, fr)
        if isinstance(callee, BoundMethod):
            return self.run_function(callee.fn, callee.owner.fi, [callee.mod] + args, [None] + anodes, kwargs, knodes, fr, callee.mod, callee.owner)
        if isinstance(callee, FuncV):
            return self.run_function(callee.node, callee.fi, args, anodes, kwargs, knodes, fr, None, None)
        if isinstance(callee, Builtin):
            return self.builtin(callee.name, args, kwargs)
        if isinstance(callee, Unk):
            return Unk("call of an unknown value: " + callee.why)
        return Unk("call of a value that is not a class or function")

    def call_ref(self, ref, args, anodes, kwargs, knodes, n, fr):
        fq = ref.fq
        last = fq.rsplit(".", 1)[-1]
        root = fq.split(".")[0]
        if fq in ("functools.partial", "partial"):
            return Partial(args[0], args[1:], kwargs) if args else Unk("partial without a target")
        if fq == "torch.nn.Parameter" or fq == "torch.nn.parameter.Parameter":
            sh = args[0].shape if args and isinstance(args[0], TensorV) else None
            return ParamV(sh if sh is not None else Unk("parameter shape not known"))
        if fq in ("torch.zeros", "torch.ones", "torch.randn", "torch.rand", "torch.empty"):
            shape = args[0] if len(args) == 1 and isinstance(args[0], (list, tuple)) else tuple(args)
            return TensorV(tuple(shape))
        if fq == "torch.full" and args:
            return TensorV(tuple(args[0]) if isinstance(args[0], (list, tuple)) else Unk("shape not known"))
        if fq.startswith("torch.nn.") and not any(x in fq for x in NO_LAYER_NS) and last[:1].isupper():
            return self.make_torch(last, args, anodes, kwargs, knodes, n, fr)
        if root == "collections" and last == "OrderedDict":
            if args and isinstance(args[0], (list, tuple)):
                return {k: v for k, v in args[0] if isinstance(k, str)}
            return dict(kwargs)
        if last[:1].isupper() and root not in ("torch", "typing", "dataclasses", "enum", "collections", "pathlib"):
            m = Mod("external", last, None, getattr(n, "lineno", None))
            m.fq = fq
            m.why = "class " + fq + " is not in the scanned repo"
            self.record_raw(m, args, anodes, kwargs, knodes, fr)
            return m
        return Unk("call of " + fq)

    def record_raw(self, m, args, anodes, kwargs, knodes, fr):
        m.pos = [(a, self.at(fr, anodes[i]) if i < len(anodes) and anodes[i] is not None else None) for i, a in enumerate(args)]
        m.kw = {k: (v, self.at(fr, knodes.get(k))) for k, v in kwargs.items()}

    def make_torch(self, name, args, anodes, kwargs, knodes, n, fr):
        m = Mod("torch", name, fr.fi.path, getattr(n, "lineno", None))
        if name in ("Sequential", "ModuleList", "ModuleDict"):
            m.container = {"Sequential": "seq", "ModuleList": "list", "ModuleDict": "dict"}[name]
            items = None
            if name == "Sequential":
                if len(args) == 1 and isinstance(args[0], dict):
                    for k, v in args[0].items():
                        self.add_child(m, str(k), v, None, fr)
                else:
                    for i, a in enumerate(args):
                        self.add_child(m, str(i), a, anodes[i] if i < len(anodes) else None, fr)
            elif name == "ModuleList":
                if args:
                    items = self.to_seq(args[0])
                    if items is None:
                        m.incomplete = True
                        m.notes.append("the list of modules is not known: " + (args[0].why if isinstance(args[0], Unk) else "not a list"))
                    else:
                        for i, a in enumerate(items):
                            self.add_child(m, str(i), a, None, fr)
            else:
                d = args[0] if args else {}
                if isinstance(d, dict):
                    for k, v in d.items():
                        self.add_child(m, str(k), v, None, fr)
                else:
                    m.incomplete = True
                    m.notes.append("the module dict is not known")
            return m
        self.record_raw(m, args, anodes, kwargs, knodes, fr)
        return m

    def add_child(self, parent, name, value, node, fr):
        if isinstance(value, Mod):
            parent.set_child(name, value)
        else:
            u = Mod("unknown", "?", None, getattr(node, "lineno", None))
            u.why = value.why if isinstance(value, Unk) else "a value that is not a module"
            parent.set_child(name, u)
            parent.incomplete = True

    def forget(self, target, fr):
        """The list that a call such as extend would have made too long: it is not known from here on, wherever it is kept."""
        if isinstance(target, ast.Name):
            fr.locals[target.id] = Unk(TOO_LARGE)
        elif isinstance(target, ast.Attribute):
            base = self.ev(target.value, fr)
            if isinstance(base, Mod):
                base.attrs[target.attr] = Unk(TOO_LARGE)

    def mutate(self, f, n, fr):
        tgt = self.ev(f.value, fr)
        args, anodes, kwargs, knodes = self.eval_args(n, fr)
        if isinstance(tgt, list):
            items = self.to_seq(args[0]) if f.attr == "extend" and args else None
            added = 1 if f.attr in ("append", "insert") else len(items) if items is not None else 0
            if len(tgt) + added > MAX_SEQ:
                self.forget(f.value, fr)
            elif f.attr == "append" and args:
                tgt.append(args[0])
            elif items is not None:
                tgt.extend(items)
            elif f.attr == "insert" and len(args) == 2 and isinstance(args[0], int):
                tgt.insert(args[0], args[1])
            return None
        if isinstance(tgt, Mod) and tgt.container in ("list", "seq"):
            items = self.to_seq(args[0]) if f.attr == "extend" and args else None
            if f.attr in ("append", "extend") and args and len(tgt.children) + (len(items) if items is not None else 1) > MAX_SEQ:
                tgt.incomplete = True
                tgt.notes.append("more than " + str(MAX_SEQ) + " modules in one list: the rest is not kept (" + TOO_LARGE + ")")
            elif f.attr == "append" and args:
                self.add_child(tgt, str(len(tgt.children)), args[0], anodes[0], fr)
            elif f.attr == "extend" and args:
                if items is None:
                    tgt.incomplete = True
                    tgt.notes.append("extend with a list that is not known")
                else:
                    for a in items:
                        self.add_child(tgt, str(len(tgt.children)), a, anodes[0], fr)
            return None
        if isinstance(tgt, Mod) and f.attr in ("add_module", "register_module") and len(args) == 2 and isinstance(args[0], str):
            self.add_child(tgt, args[0], args[1], anodes[1], fr)
            return None
        if isinstance(tgt, Mod) and tgt.container == "dict":
            return None
        return None

    def builtin_refusal(self, name, args, kwargs):
        """Why a builtin is not run on these arguments, because it would build or loop over too much (value too large), or None.
        Asked BEFORE it runs, from the sizes of the arguments."""
        if name == "pow":
            base = args[0] if args else kwargs.get("base")
            exp = args[1] if len(args) > 1 else kwargs.get("exp")
            # pow(a, b, m) stays below m, so only the two-argument form can grow
            if (args[2] if len(args) > 2 else kwargs.get("mod")) is None and isinstance(base, int) and isinstance(exp, int):
                return binop_refusal(ast.Pow, base, exp)
        elif name in ("sum", "min", "max") and args and (name == "sum" or len(args) == 1):
            n = seq_len(args[0])
            if n is not None and n > MAX_SEQ:
                return TOO_LARGE
            start = args[1] if len(args) > 1 else kwargs.get("start")
            # sum(lists, []) joins them
            if name == "sum" and isinstance(start, (list, tuple)) and isinstance(args[0], (list, tuple)):
                if len(start) + sum(len(x) for x in args[0] if isinstance(x, (list, tuple))) > MAX_SEQ:
                    return TOO_LARGE
        elif name in ("int", "range"):
            # int("999...") costs time by the square of the digits; no int above MAX_BITS bits is built anyway
            if any(isinstance(a, str) and len(a) > MAX_BITS + 64 for a in args):
                return TOO_LARGE
        elif name == "round":
            nd = args[1] if len(args) > 1 else kwargs.get("ndigits")
            # round(5, -10**7) works out 10**(10**7)
            if isinstance(nd, int) and abs(nd) > 1000:
                return TOO_LARGE
        elif name == "str" and args and isinstance(args[0], (list, tuple, dict)) and not small(args[0]):
            return TOO_LARGE
        return None

    def builtin(self, name, args, kwargs):
        if any(isinstance(a, Unk) for a in args):
            if name in ("print",):
                return None
            return Unk(name + " with an unknown argument")
        why = self.builtin_refusal(name, args, kwargs)
        if why:
            return Unk(why)
        try:
            if name == "range":
                return range(*[int(a) for a in args])
            if name == "len":
                a = args[0]
                if isinstance(a, Mod) and a.container:
                    return len(a.children)
                return len(a)
            if name in ("int", "float", "str", "bool", "abs", "round", "sum", "min", "max", "pow", "divmod", "ord", "chr"):
                fn = {"int": int, "float": float, "str": str, "bool": bool, "abs": abs, "round": round, "sum": sum,
                      "min": min, "max": max, "pow": pow, "divmod": divmod, "ord": ord, "chr": chr}[name]
                r = fn(*args, **kwargs)
                # int(config.x), str(config.x) and the like keep the tag of their argument
                return taint(r, _taint_at(*args)) if name in ("int", "float", "str", "abs", "round", "pow", "divmod") else r
            if name in ("list", "tuple"):
                items = self.to_seq(args[0]) if args else []
                if items is None:
                    return Unk(name + " of a value that is not known")
                return list(items) if name == "list" else tuple(items)
            if name == "dict":
                return dict(args[0]) if args else dict(kwargs)
            if name == "enumerate":
                items = self.to_seq(args[0])
                return Unk("enumerate of an unknown value") if items is None else list(enumerate(items, kwargs.get("start", args[1] if len(args) > 1 else 0)))
            if name == "zip":
                seqs = [self.to_seq(a) for a in args]
                return Unk("zip of an unknown value") if any(s is None for s in seqs) else list(zip(*seqs))
            if name == "sorted":
                items = self.to_seq(args[0])
                return Unk("sorted of an unknown value") if items is None else sorted(items)
            if name == "reversed":
                items = self.to_seq(args[0])
                return Unk("reversed of an unknown value") if items is None else list(reversed(items))
            if name in ("any", "all"):
                items = self.to_seq(args[0])
                return Unk(name + " of an unknown value") if items is None else (any(items) if name == "any" else all(items))
            if name == "print":
                return None
            if name == "isinstance" and len(args) == 2:
                kinds = {"tuple": tuple, "list": list, "int": int, "float": float, "str": str, "bool": bool, "dict": dict}
                want = args[1] if isinstance(args[1], (list, tuple)) else [args[1]]
                if all(isinstance(w, Builtin) and w.name in kinds for w in want) and (args[0] is None or isinstance(args[0], (bool, int, float, str, list, tuple, dict))):
                    return isinstance(args[0], tuple(kinds[w.name] for w in want))
                return Unk("isinstance of a value that is not a plain type")
        except Exception as e:
            return Unk(name + " failed: " + str(e)[:60])
        return Unk("builtin " + name + " is not evaluated")

    # ---------- classes ----------
    def bind(self, fn, owner_fi, args, anodes, kwargs, knodes, caller, skip_first):
        a = fn.args
        pos = list(a.posonlyargs) + list(a.args)
        defaults = [None] * (len(pos) - len(a.defaults)) + list(a.defaults)
        out = {}
        params = pos[1:] if skip_first else pos
        defs = defaults[1:] if skip_first else defaults
        for i, p in enumerate(params):
            if i < len(args):
                out[p.arg] = (args[i], self.at(caller, anodes[i]) if i < len(anodes) and anodes[i] is not None else None)
            elif p.arg in kwargs:
                out[p.arg] = (kwargs[p.arg], self.at(caller, knodes.get(p.arg)))
            elif defs[i] is not None:
                out[p.arg] = (self.ev(defs[i], Frame(owner_fi)), owner_fi.path + ":" + str(defs[i].lineno))
            else:
                out[p.arg] = (Unk("no value for " + p.arg), None)
        for p, d in zip(a.kwonlyargs, a.kw_defaults):
            if p.arg in kwargs:
                out[p.arg] = (kwargs[p.arg], self.at(caller, knodes.get(p.arg)))
            elif d is not None:
                out[p.arg] = (self.ev(d, Frame(owner_fi)), owner_fi.path + ":" + str(d.lineno))
            else:
                out[p.arg] = (Unk("no value for " + p.arg), None)
        names = {p.arg for p in params} | {p.arg for p in a.kwonlyargs}
        if a.vararg:
            out[a.vararg.arg] = (tuple(args[len(params):]), None)
        if a.kwarg:
            out[a.kwarg.arg] = ({k: v for k, v in kwargs.items() if k not in names}, None)
        return out

    def instantiate(self, info, args, anodes, kwargs, knodes, n, fr):
        if fr.depth >= MAX_DEPTH:
            return Unk("constructor calls nest too deep")
        init, owner = self.find_init(info)
        if init is None and self.is_dataclass(info):
            return self.dataclass_value(info, args, kwargs)
        mod = Mod("repo", info.name, info.fi.path, info.line, info)
        if init is None:
            self.record_raw(mod, args, anodes, kwargs, knodes, fr)
            self.base_layers(mod, info)
            return mod
        bound = self.bind(init, owner.fi, args, anodes, kwargs, knodes, fr, True)
        mod.args = bound
        self.run_init(mod, owner, init, bound, fr.depth + 1)
        return mod

    def is_dataclass(self, info):
        return any(last_name(d.func if isinstance(d, ast.Call) else d) == "dataclass" for d in info.node.decorator_list)

    def dataclass_value(self, info, args, kwargs):
        """A dataclass is a bag of fields. Its instance is a dict of the values, so config.n_layer can be read."""
        fields = []
        for c in reversed(self.mro(info)):
            for st in c.node.body:
                if isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name):
                    fields.append((st.target.id, st.value, c.fi))
        out = {}
        for i, (name, default, fi) in enumerate(fields):
            if i < len(args):
                out[name] = args[i]
            elif name in kwargs:
                out[name] = kwargs[name]
            elif default is not None:
                out[name] = self.ev(default, Frame(fi))
            else:
                out[name] = Unk("no value for " + name)
        return out

    def base_layers(self, mod, info):
        for c in self.mro(info):
            for b in c.node.bases:
                r = self.base_of(b, c.fi)
                if r and r[0] == "torch" and r[1].rsplit(".", 1)[-1] not in ("Module",):
                    mod.base_layer = (r[1].rsplit(".", 1)[-1], [], {})
                    return

    def find_init(self, info):
        for c in self.mro(info):
            if "__init__" in c.methods:
                return c.methods["__init__"], c
        return None, None

    def run_init(self, mod, owner, init, bound, depth):
        first = (init.args.posonlyargs + init.args.args)[0].arg if (init.args.posonlyargs + init.args.args) else "self"
        loc = {k: v[0] for k, v in bound.items()}
        loc[first] = mod
        fr = Frame(owner.fi, loc, mod, owner, depth)
        try:
            self.run_block(init.body, fr)
        except (Halt, Ret):
            pass
        except Budget:
            raise

    def super_init(self, n, fr):
        owner = fr.owner
        mod = fr.mod
        if owner is None or mod is None:
            return None
        args, anodes, kwargs, knodes = self.eval_args(n, fr)
        for b in owner.node.bases:
            r = self.base_of(b, owner.fi)
            if r is None:
                continue
            if r[0] == "repo":
                init, o2 = self.find_init(r[1])
                if init is not None:
                    bound = self.bind(init, o2.fi, args, anodes, kwargs, knodes, fr, True)
                    self.run_init(mod, o2, init, bound, fr.depth + 1)
                return None
            if r[0] == "torch" and r[1].rsplit(".", 1)[-1] != "Module":
                mod.base_layer = (r[1].rsplit(".", 1)[-1], [(a, None) for a in args], {k: (v, None) for k, v in kwargs.items()})
                return None
            if r[0] == "ext":
                mod.notes.append("the base class " + r[1] + " is not in the scanned repo")
                mod.incomplete = True
                return None
        return None

    def run_function(self, fn, fi, args, anodes, kwargs, knodes, caller, mod, owner):
        if caller.depth >= MAX_DEPTH:
            return Unk("calls nest too deep")
        bound = self.bind(fn, fi, args, anodes, kwargs, knodes, caller, False)
        loc = {k: v[0] for k, v in bound.items()}
        fr = Frame(fi, loc, mod, owner, caller.depth + 1)
        try:
            self.run_block(fn.body, fr)
        except Ret as r:
            return r.value
        except Halt:
            return Unk("function stopped")
        return None

    # ---------- statements ----------
    def run_block(self, stmts, fr):
        for s in stmts:
            self.run_stmt(s, fr)

    def creates_modules(self, stmts):
        for s in stmts:
            for x in ast.walk(s):
                if isinstance(x, ast.Assign) and any(isinstance(t, ast.Attribute) for t in x.targets) and isinstance(x.value, (ast.Call, ast.ListComp)):
                    return True
                if isinstance(x, ast.Call) and isinstance(x.func, ast.Attribute) and x.func.attr in ("append", "extend", "add_module", "register_module"):
                    return True
        return False

    def skipped(self, stmts, fr, why):
        if fr.mod is not None and self.creates_modules(stmts):
            fr.mod.incomplete = True
            fr.mod.notes.append("skipped code that adds modules: " + why)

    def run_stmt(self, s, fr):
        self.tick()
        t = type(s)
        if t is ast.Assign:
            v = self.ev(s.value, fr)
            for tg in s.targets:
                self.assign(tg, v, s.value, fr)
        elif t is ast.AnnAssign:
            if s.value is not None:
                self.assign(s.target, self.ev(s.value, fr), s.value, fr)
        elif t is ast.AugAssign:
            if isinstance(s.target, ast.Name):
                cur = fr.locals.get(s.target.id, Unk("not set"))
                fake = ast.BinOp(left=ast.Constant(0), op=s.op, right=s.value)
                ast.copy_location(fake, s)
                fr2 = fr.sub()
                fr2.locals["__aug__"] = cur
                fake.left = ast.Name(id="__aug__", ctx=ast.Load())
                fr.locals[s.target.id] = self.ev(fake, fr2)
        elif t is ast.Expr:
            if not isinstance(s.value, ast.Constant):
                self.ev(s.value, fr)
        elif t is ast.If:
            c = truth(self.ev(s.test, fr))
            if c is None:
                self.skipped(s.body + s.orelse, fr, "an if on a value that is not known (line " + str(s.lineno) + ")")
            elif c:
                self.run_block(s.body, fr)
            else:
                self.run_block(s.orelse, fr)
        elif t is ast.For:
            seq = self.to_seq(self.ev(s.iter, fr))
            if seq is None or len(seq) > MAX_LOOP:
                self.skipped(s.body, fr, "a loop over a value that is not known (line " + str(s.lineno) + ")")
            else:
                for item in seq:
                    self.bind_target(s.target, item, fr)
                    try:
                        self.run_block(s.body, fr)
                    except Brk:
                        break
                    except Cnt:
                        continue
                else:
                    self.run_block(s.orelse, fr)
        elif t is ast.While:
            self.skipped(s.body, fr, "a while loop (line " + str(s.lineno) + ")")
        elif t is ast.With:
            self.run_block(s.body, fr)
        elif t is ast.Try:
            try:
                self.run_block(s.body, fr)
            finally:
                self.run_block(s.finalbody, fr)
        elif t is ast.Return:
            raise Ret(self.ev(s.value, fr) if s.value is not None else None)
        elif t is ast.Raise:
            raise Halt()
        elif t is ast.Break:
            raise Brk()
        elif t is ast.Continue:
            raise Cnt()
        elif t in (ast.FunctionDef, ast.AsyncFunctionDef):
            fr.locals[s.name] = FuncV(s, fr.fi)
        # assert, pass, import, delete, global, class inside a function: nothing to do

    def maybe_module_call(self, rhs, fr):
        if not isinstance(rhs, ast.Call):
            return False
        nm = last_name(rhs.func)
        return nm[:1].isupper() or any(nm.lower().endswith(x) for x in LOOKS_LIKE_MODULE)

    def assign(self, tg, v, rhs, fr):
        if isinstance(tg, ast.Name):
            fr.locals[tg.id] = v
        elif isinstance(tg, ast.Attribute):
            base = self.ev(tg.value, fr)
            if isinstance(base, Mod) and base.kind == "torch" and tg.attr in ("weight", "bias") and isinstance(v, PRef):
                if v.mod is not base:
                    base.tied[tg.attr] = v.mod
            elif isinstance(base, Mod):
                self.set_attr(base, tg.attr, v, rhs, fr)
        elif isinstance(tg, (ast.Tuple, ast.List)):
            self.bind_target(tg, v, fr)

    def set_attr(self, mod, name, v, rhs, fr):
        mod.attrs[name] = v
        if name in self.dim_names and name not in mod.attr_at:
            line = getattr(rhs, "lineno", None)
            mod.attr_at[name] = (fr.fi.path + ":" + str(line) if line else None, ast.unparse(rhs)[:80] if rhs is not None else None)
        if isinstance(v, Mod):
            mod.set_child(name, v)
        elif isinstance(v, ParamV):
            mod.params = [p for p in mod.params if p[0] != name] + [[name, v.shape]]
        elif isinstance(v, Unk) and self.maybe_module_call(rhs, fr):
            u = Mod("unknown", "?", None, getattr(rhs, "lineno", None))
            u.why = v.why
            mod.set_child(name, u)


# ---------- output ----------
def jv(v, depth=0, left=None):
    if left is None:
        left = [MAX_NODES]   # one value writes at most this many elements, however its parts are shared
    left[0] -= 1
    if left[0] < 0:
        return {"unknown": "too large"}
    if depth > 6:
        return {"unknown": "too deep"}
    v = plain(v)
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        return v if v == v and abs(v) != float("inf") else str(v)
    if isinstance(v, (list, tuple)):
        return [jv(x, depth + 1, left) for x in list(v)[:64]]
    if isinstance(v, range):
        return [jv(x, depth + 1, left) for x in v[:64]]
    if isinstance(v, dict):
        return {str(plain(k)): jv(x, depth + 1, left) for k, x in list(v.items())[:64]}
    if isinstance(v, Unk):
        return {"unknown": v.why}
    if isinstance(v, Cls):
        return {"class": v.info.name}
    if isinstance(v, (Ref, Builtin)):
        return {"ref": v.fq if isinstance(v, Ref) else v.name}
    if isinstance(v, Partial):
        return {"partial": jv(v.target, depth + 1, left), "args": [jv(a, depth + 1, left) for a in v.args], "kwargs": {k: jv(x, depth + 1, left) for k, x in v.kwargs.items()}}
    if isinstance(v, Mod):
        return {"module": v.cls}
    if isinstance(v, (TensorV, ParamV)):
        return {"tensor": jv(list(v.shape), depth + 1, left) if not isinstance(v.shape, Unk) else {"unknown": v.shape.why}}
    if isinstance(v, FuncV):
        return {"ref": v.node.name}
    if isinstance(v, PRef):
        return {"ref": "weight of " + v.mod.cls}
    return {"unknown": type(v).__name__}


def config_at(v, depth=0):
    """The at of a value that came from a config, or None. A container counts when every number and string
    in it is tainted (bool and None are not tracked and do not count either way)."""
    if isinstance(v, (CInt, CFloat, CStr)):
        return v.at
    if depth > 6 or not isinstance(v, (list, tuple, dict)):
        return None
    first = None
    for x in (v.values() if isinstance(v, dict) else v):
        if x is None or isinstance(x, bool):
            continue
        a = config_at(x, depth + 1)
        if a is None:
            return None
        first = first or a
    return first


def rec(pair):
    v, at = pair
    out = {"v": jv(v)}
    cat = config_at(v)
    if cat is not None:
        out["src"] = "config"
        out["at"] = cat
    elif at:
        out["at"] = at
    return out


def mod_json(m, path, seen):
    j = {"cls": m.cls, "kind": m.kind}
    if m.file:
        j["file"] = m.file
    if m.line:
        j["line"] = m.line
    if m.kind == "repo":
        j["args"] = {k: rec(p) for k, p in m.args.items() if k not in ("self",)}
        if not m.args and (m.pos or m.kw):
            j["pos"] = [rec(p) for p in m.pos]
            j["kw"] = {k: rec(p) for k, p in m.kw.items()}
    elif m.kind in ("torch", "external"):
        j["pos"] = [rec(p) for p in m.pos]
        j["kw"] = {k: rec(p) for k, p in m.kw.items()}
    if m.fq:
        j["fq"] = m.fq
    if m.why:
        j["why"] = m.why
    if m.container:
        j["container"] = m.container
    if m.params:
        j["params"] = []
        for n, s in m.params:
            pj = {"name": n, "shape": jv(list(s)) if not isinstance(s, Unk) else {"unknown": s.why}}
            if not isinstance(s, Unk) and config_at(list(s)) is not None:
                pj["src"] = "config"
            j["params"].append(pj)
    if m.tied:
        j["tied"] = {k: t.id for k, t in m.tied.items()}
    if m.base_layer:
        nm, pos, kw = m.base_layer
        j["baseLayer"] = {"cls": nm, "pos": [rec(p) for p in pos], "kw": {k: rec(p) for k, p in kw.items()}}
    if m.notes:
        j["notes"] = m.notes[:6]
    if m.incomplete:
        j["incomplete"] = True
    kids = []
    for name, c in m.children:
        cp = (path + "." if path else "") + name
        if c.id in seen:
            kids.append({"name": name, "path": cp, "cls": c.cls, "kind": c.kind, "alias": seen[c.id]})
            continue
        seen[c.id] = cp
        cj = mod_json(c, cp, seen)
        cj["name"], cj["path"] = name, cp
        kids.append(cj)
    j["children"] = kids
    return j


def fix_tied(j, seen):
    if "tied" in j:
        j["tied"] = {k: seen.get(i, "?") for k, i in j["tied"].items()}
    for c in j.get("children", []):
        fix_tied(c, seen)


# ---------- the input and output contract of forward (read from the text; never run) ----------
DOC_PARAMS = ("args", "arguments", "parameters", "params", "keyword args", "keyword arguments", "inputs")
DOC_RETURNS = ("returns", "return", "yields", "outputs")
DOC_OTHER = ("raises", "examples", "example", "note", "notes", "attributes", "see also", "references", "warning",
             "warnings", "todo", "shape", "shapes")
# a dimension list: "shape (B, N, D)", "(batch, seq_len, dim)", "[B, N, 3]"; without the word shape it needs 2 items
SHAPE_RE = re.compile(r"(shape\s*[:=]?\s*\x60?\s*)?([\(\[])\s*(\w+|\.\.\.)((?:\s*,\s*(?:\w+|\.\.\.))*)\s*,?\s*([\)\]])", re.I)
NOT_DIMS = {"tensor", "optional", "int", "float", "str", "bool", "list", "dict", "tuple", "none", "default", "or",
            "and", "the", "of", "a", "an", "torch", "array", "ndarray", "longtensor", "floattensor", "type", "e", "g", "ie", "eg"}
MAX_DOC_TEXT = 400
MAX_KEYS = 64


def shape_hint(text):
    """The first dimension list in text as a list of words, or None. Only words, integers and "..."."""
    for m in SHAPE_RE.finditer(text or ""):
        if (m.group(2) == "(") != (m.group(5) == ")"):
            continue
        words = [m.group(3)] + [w.strip() for w in m.group(4).split(",") if w.strip()]
        if not m.group(1) and len(words) < 2:
            continue
        if any(w.lower() in NOT_DIMS for w in words):
            continue
        return words[:8]
    return None


def doc_sections(doc):
    """{section name: [(indent, text)]} of a Google style ("Args:") or simple NumPy style ("Parameters" + dashes)
    docstring. Section names are lower case."""
    lines = (doc or "").split("\n")
    known = DOC_PARAMS + DOC_RETURNS + DOC_OTHER
    out, cur, base, numpy = {}, None, 0, False
    i = 0
    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        ind = len(ln) - len(ln.lstrip())
        low = s[:-1].strip().lower() if s.endswith(":") else s.lower()
        under = i + 1 < len(lines) and len(lines[i + 1].strip()) >= 3 and set(lines[i + 1].strip()) == {"-"}
        if low in known and (s.endswith(":") or under):
            cur, base, numpy = low, ind, under and not s.endswith(":")
            out.setdefault(cur, [])
            i += 2 if numpy else 1
            continue
        if cur is not None and s:
            if ind < base or (ind == base and not numpy):
                cur = None
            else:
                out[cur].append((ind, s))
        i += 1
    return out


ENTRY_RE = re.compile(r"^\*{0,2}([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:\s*(.*)$")
NUMPY_ENTRY_RE = re.compile(r"^\*{0,2}([A-Za-z_]\w*)\s*(?::\s*(.*))?$")


def doc_entries(items):
    """{name: text} from the lines of an Args or Parameters section: "name (type): text" or "name : type" with the
    text on the lines below, more indented. Continuation lines are joined with spaces."""
    out, cur, ind0 = {}, None, None
    for ind, s in items:
        if ind0 is None:
            ind0 = ind
        if ind == ind0:
            m = ENTRY_RE.match(s)
            if m:
                cur = m.group(1)
                out[cur] = m.group(3).strip()
                continue
            m = NUMPY_ENTRY_RE.match(s)
            if m:
                cur = m.group(1)
                out[cur] = ""
                continue
            cur = None
        elif cur is not None:
            out[cur] = (out[cur] + " " + s).strip()
    return {k: v[:MAX_DOC_TEXT] for k, v in out.items()}


def ann_has_none(a, depth=0):
    """Whether an annotation allows None: X | None, None | X, Optional[X], Union[X, None] (also as a string annotation)."""
    if a is None or depth > 6:
        return False
    if isinstance(a, ast.Constant):
        if a.value is None:
            return True
        if isinstance(a.value, str) and len(a.value) < 200:
            try:
                return ann_has_none(ast.parse(a.value, mode="eval").body, depth + 1)
            except SyntaxError:
                return False
        return False
    if isinstance(a, ast.BinOp) and isinstance(a.op, ast.BitOr):
        return ann_has_none(a.left, depth + 1) or ann_has_none(a.right, depth + 1)
    if isinstance(a, ast.Subscript):
        nm = last_name(a.value)
        if nm == "Optional":
            return True
        if nm == "Union":
            elts = a.slice.elts if isinstance(a.slice, ast.Tuple) else [a.slice]
            return any(ann_has_none(e, depth + 1) for e in elts)
    return False


def own_nodes(fn):
    """The nodes of a function body in source order, leaving out nested functions, classes and lambdas."""
    out = []

    def go(n):
        for c in ast.iter_child_nodes(n):
            if isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            out.append(c)
            go(c)
    for st in fn.body:
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        out.append(st)
        go(st)
    return out


def str_key(n):
    return n.value if isinstance(n, ast.Constant) and isinstance(n.value, str) else None


def output_of(fn):
    """What forward returns, read from its body as text: the keys of a returned dict in the order they first appear
    (outputs["a"] = ..., outputs = {"a": ...}, return {"a": ...}, return dict(a=...)) and the names of a returned tuple
    of plain names (return a, b)."""
    nodes = own_nodes(fn)
    rets = [n for n in nodes if isinstance(n, ast.Return) and n.value is not None]
    dict_locals = set()
    for n in nodes:
        if isinstance(n, (ast.Assign, ast.AnnAssign)) and n.value is not None:
            v = n.value
            if isinstance(v, ast.Dict) or (isinstance(v, ast.Call) and last_name(v.func) == "dict" and isinstance(v.func, ast.Name)):
                for t in (n.targets if isinstance(n, ast.Assign) else [n.target]):
                    if isinstance(t, ast.Name):
                        dict_locals.add(t.id)
    returned = {r.value.id for r in rets if isinstance(r.value, ast.Name)} & dict_locals
    seen = []  # (line, col, key)

    def add(node, key):
        if key is not None:
            seen.append((getattr(node, "lineno", 0), getattr(node, "col_offset", 0), key))

    def dict_keys(v):
        if isinstance(v, ast.Dict):
            for k in v.keys:
                if k is not None:
                    add(k, str_key(k))
        elif isinstance(v, ast.Call) and isinstance(v.func, ast.Name) and v.func.id == "dict":
            for kw in v.keywords:
                if kw.arg:
                    add(kw.value, kw.arg)
    for n in nodes:
        targets = n.targets if isinstance(n, ast.Assign) else [n.target] if isinstance(n, (ast.AugAssign, ast.AnnAssign)) else []
        for t in targets:
            if isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id in returned:
                add(t, str_key(t.slice))
            elif isinstance(t, ast.Name) and t.id in returned and getattr(n, "value", None) is not None:
                dict_keys(n.value)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name) and n.func.value.id in returned:
            if n.func.attr == "update":
                for a in n.args:
                    dict_keys(a)
                for kw in n.keywords:
                    if kw.arg:
                        add(kw.value, kw.arg)
            elif n.func.attr == "setdefault" and n.args:
                add(n, str_key(n.args[0]))
    for r in rets:
        dict_keys(r.value)
    keys = []
    for _l, _c, k in sorted(seen, key=lambda x: (x[0], x[1])):
        if k not in keys:
            keys.append(k)
    out = {"keys": keys[:MAX_KEYS]}
    if len(keys) > MAX_KEYS:
        out["keysMore"] = len(keys) - MAX_KEYS
    for r in rets:
        if isinstance(r.value, ast.Tuple) and r.value.elts and all(isinstance(e, ast.Name) for e in r.value.elts):
            out["names"] = [e.id for e in r.value.elts][:MAX_KEYS]
            break
    return out


def forward_json(scan, info):
    fn, owner = scan.find_method(info, "forward")
    if fn is None:
        return None
    a = fn.args
    pos = list(a.posonlyargs) + list(a.args)
    defaults = [None] * (len(pos) - len(a.defaults)) + list(a.defaults)
    full_doc = ast.get_docstring(fn) or ""
    secs = doc_sections(full_doc)
    entries = {}
    for s in DOC_PARAMS:
        for k, v in doc_entries(secs.get(s, [])).items():
            entries.setdefault(k, v)

    def param(p, d, kwonly):
        j = {"name": p.arg, "annotation": ast.unparse(p.annotation) if p.annotation else None,
             "default": ast.unparse(d) if d is not None else None}
        if kwonly:
            j["kwonly"] = True
        # optional: the caller may leave it out (it has a default, any default). nullable: the type allows None.
        # A required parameter typed X | None is nullable but not optional: leaving it out is a TypeError.
        j["optional"] = d is not None
        j["nullable"] = ann_has_none(p.annotation)
        if p.arg in entries:
            j["docText"] = entries[p.arg]
            sh = shape_hint(entries[p.arg])
            if sh:
                j["shapeHint"] = sh
        return j
    params = [param(p, d, False) for p, d in list(zip(pos, defaults))[1:]]
    params += [param(p, d, True) for p, d in zip(a.kwonlyargs, a.kw_defaults)]
    out = output_of(fn)
    ret_lines = []
    for s in DOC_RETURNS:
        ret_lines += secs.get(s, [])
    rtext = " ".join(s for _i, s in ret_lines)[:MAX_DOC_TEXT]
    if rtext:
        out["docText"] = rtext
        # the shape of the whole output: the first line of the Returns text, when it names one
        sh = shape_hint(ret_lines[0][1])
        if sh:
            out["shapeHint"] = sh
        # "key: text" lines in the Returns text for the keys found in the body
        kd = doc_entries(ret_lines[1:] if len(ret_lines) > 1 else ret_lines)
        for k in out["keys"]:
            if k in kd:
                out.setdefault("keyDocs", {})[k] = kd[k]
                sh = shape_hint(kd[k])
                if sh:
                    out.setdefault("keyShapes", {})[k] = sh
    end = getattr(fn, "end_lineno", None)
    return {"file": owner.fi.path, "line": fn.lineno, **({"end": end} if end else {}), "owner": owner.name, "params": params,
            "returns": ast.unparse(fn.returns) if fn.returns else None,
            "doc": (full_doc or "")[:600] or None, "output": out}


def dims_json(scan, mod, names, set_names):
    """Where the scan saw a dimension name: the root's arguments (and the fields of a config it was given), the
    attributes of every module in tree order (first instance wins), floor divisions of two such names anywhere in
    the repo, and assignments to an attribute in set_names (e.g. head_dim). Values are value records."""
    args, attrs, got = [], [], set()
    for name, pair in mod.args.items():
        if name in names:
            args.append({"name": name, **rec(pair)})
        v = plain(pair[0])
        if isinstance(v, dict):
            for k, x in list(v.items())[:200]:
                if isinstance(k, str) and k in names:
                    args.append({"name": k, "via": name, **rec((x, None))})
    seen = set()

    def walk(m, path):
        if m.id in seen:
            return
        seen.add(m.id)
        for name, v in m.attrs.items():
            if name not in names or name in got:
                continue
            p = plain(v)
            if not isinstance(p, int) or isinstance(p, bool):
                continue
            got.add(name)
            at, expr = m.attr_at.get(name, (None, None))
            r = rec((v, at))
            e = {"name": name, "cls": m.cls, "path": path, **r}
            if expr:
                e["expr"] = expr
            if at and r.get("at") != at:
                e["set"] = at
            attrs.append(e)
        for cname, c in m.children:
            walk(c, (path + "." if path else "") + cname)
    walk(mod, "")
    divs, sets = [], []
    for path in sorted(scan.files):
        for n in ast.walk(scan.files[path].tree):
            if isinstance(n, ast.BinOp) and isinstance(n.op, ast.FloorDiv):
                a, b = last_name(n.left), last_name(n.right)
                if a in names and b in names:
                    divs.append((path, n.lineno, {"a": a, "b": b, "at": path + ":" + str(n.lineno)}))
            elif isinstance(n, (ast.Assign, ast.AnnAssign)):
                for t in (n.targets if isinstance(n, ast.Assign) else [n.target]):
                    if isinstance(t, ast.Attribute) and t.attr in set_names:
                        sets.append((path, n.lineno, {"name": t.attr, "at": path + ":" + str(n.lineno)}))
    divs.sort(key=lambda x: (x[0], x[1]))
    sets.sort(key=lambda x: (x[0], x[1]))
    return {"args": args, "attrs": attrs, "floordiv": [d for _p, _l, d in divs[:20]], "assigned": [s for _p, _l, s in sets[:20]]}


def candidates(scan):
    used = set()
    names = set(scan.by_name)
    for fi in scan.files.values():
        def walk(node, stack):
            if isinstance(node, ast.ClassDef):
                stack = stack + [node.name]
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in names and node.id not in stack:
                used.add(node.id)
            if isinstance(node, ast.Attribute) and node.attr in names and node.attr not in stack:
                used.add(node.attr)
            for ch in ast.iter_child_nodes(node):
                walk(ch, stack)
        walk(fi.tree, [])
    def direct(info):
        names_ = set()
        init, _ = scan.find_init(info)
        if init is not None:
            for x in ast.walk(init):
                if isinstance(x, ast.Call) and last_name(x.func) in names:
                    names_.add(last_name(x.func))
                elif isinstance(x, ast.Name) and isinstance(x.ctx, ast.Load) and x.id in names:
                    names_.add(x.id)
        names_.discard(info.name)
        return names_

    def closure(info):
        seen_, todo = set(), [info.name]
        while todo and len(seen_) < 500:
            nm = todo.pop()
            for c in scan.by_name.get(nm, []):
                for d in direct(c):
                    if d not in seen_:
                        seen_.add(d)
                        todo.append(d)
        seen_.discard(info.name)
        return len(seen_)

    out = []
    for name, lst in scan.by_name.items():
        for info in lst:
            if not scan.is_module(info):
                continue
            fwd, _ = scan.find_method(info, "forward")
            out.append({"name": name, "file": info.fi.path, "line": info.line, "hasForward": fwd is not None,
                        "used": name in used, "score": closure(info)})
    # the model is the class that builds the most other classes of the repo; then the one nobody else uses
    out.sort(key=lambda c: (not c["hasForward"], -c["score"], c["used"], c["name"]))
    return out


CONFIG_NAMES = ("config", "cfg", "conf", "args", "hparams", "params")


def config_use(scan, info, cfg, kwargs):
    """Which parameter of the root __init__ receives the config. Returns {"arg": name | "**" | None, "note"?}."""
    init, _ = scan.find_init(info)
    names, required, star = [], [], False
    if init is not None:
        a = init.args
        pos = (list(a.posonlyargs) + list(a.args))[1:]
        nd = len(pos) - len(a.defaults)
        names = [p.arg for p in pos] + [p.arg for p in a.kwonlyargs]
        required = [p.arg for p in pos[:max(nd, 0)]] + [p.arg for p, d in zip(a.kwonlyargs, a.kw_defaults) if d is None]
        star = a.kwarg is not None
    want = cfg.get("arg")
    if want == "**":
        if not isinstance(cfg.get("data"), dict):
            return {"arg": None, "note": "--config-arg ** needs a config section that is a map; the config is not used"}
        return {"arg": "**"}
    if want:
        if want in kwargs:
            return {"arg": None, "note": "--arg " + want + " is given, so the config file is not used for it"}
        if want not in names and not star:
            return {"arg": None, "note": info.name + ".__init__ has no parameter " + want + "; the config is not used"}
        return {"arg": want}
    for nm in required:
        if nm in CONFIG_NAMES and nm not in kwargs:
            return {"arg": nm}
    return {"arg": None, "note": "no parameter of " + info.name + ".__init__ looks like a config (" + ", ".join(CONFIG_NAMES) +
            "); the config is not used. Name it with --config-arg NAME, or --config-arg ** to pass its keys as arguments"}


def main():
    job = json.loads(sys.stdin.read())
    root = os.path.realpath(job["root"])
    scan = Interp()
    dim_names = frozenset(str(x) for x in (job.get("dimNames") or []))
    scan.dim_names = dim_names
    errors = []
    read = 0
    for rel in job.get("files", []):
        full = os.path.realpath(os.path.join(root, rel))
        if not (full == root or full.startswith(root + os.sep)):
            errors.append({"file": rel, "error": "outside the repo folder; skipped"})
            continue
        try:
            if os.path.getsize(full) > MAX_FILE_BYTES:
                errors.append({"file": rel, "error": "larger than 2 MB; skipped"})
                continue
            with open(full, "rb") as fh:
                text = fh.read().decode("utf-8", "replace")
            scan.add(rel.replace(os.sep, "/"), text)
            read += 1
        except SyntaxError as e:
            errors.append({"file": rel, "error": "syntax: " + str(e.msg) + " line " + str(e.lineno)})
        except (OSError, ValueError, RecursionError) as e:
            errors.append({"file": rel, "error": type(e).__name__ + ": " + str(e)[:80]})
    result = {"version": 1, "python": sys.version.split()[0], "errors": errors,
              "stats": {"files": read, "classes": sum(len(v) for v in scan.by_name.values())}}
    cands = candidates(scan)
    result["candidates"] = cands[:20]
    name = job.get("rootClass") or (cands[0]["name"] if cands else None)
    result["rootClass"] = name
    result["root"] = None
    info = scan.pick_class(name) if name else None
    if info is not None:
        # values given on the command line (--arg) are tagged like config values
        kwargs = {k: taint_tree(v, None, lambda _l: "command line") for k, v in (job.get("args") or {}).items()}
        cfg = job.get("config")
        if cfg:
            use = config_use(scan, info, cfg, kwargs)
            result["configUse"] = use
            if use.get("arg"):
                f = cfg.get("file") or "config"
                tagged = taint_tree(cfg.get("data"), cfg.get("lines"), lambda l: f + ":" + str(l) if isinstance(l, int) and not isinstance(l, bool) else f)
                if use["arg"] == "**":
                    for k, v in tagged.items():
                        kwargs.setdefault(str(k), v)
                else:
                    kwargs[use["arg"]] = tagged
        fr = Frame(info.fi)
        try:
            mod = scan.instantiate(info, [], [], kwargs, {}, ast.Constant(0, lineno=info.line), fr)
            seen = {mod.id: ""}
            result["root"] = mod_json(mod, "", seen)
            fix_tied(result["root"], seen)
            result["root"]["name"], result["root"]["path"] = info.name, ""
            result["forward"] = forward_json(scan, info)
            if dim_names:
                result["dims"] = dims_json(scan, mod, dim_names, frozenset(str(x) for x in (job.get("dimAttrs") or [])))
        except Budget as e:
            result["warnings"] = [(str(e) or "step budget exceeded") + "; the tree may be partial"]
    elif name:
        result["warnings"] = ["class " + name + " was not found"]
    same = [c for c in scan.by_name.get(info.name, [])] if info is not None else []
    if len(same) > 1:
        result.setdefault("warnings", []).append(
            str(len(same)) + " classes are named " + info.name + "; mapped the one in " + info.fi.path + ". Use --root-class path.py:" + info.name + " to pick another.")
    result["stats"]["steps"] = scan.steps
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
