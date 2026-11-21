// Parameter counts of torch.nn layers, from their constructor arguments, and the state_dict keys they hold.
// A value that the scan could not know makes the count unknown, with a reason. Buffers (running statistics)
// are not parameters.
// Source: an argument record may carry src ("config" when it came from a config file or --arg; absent means
// "code"). layerParams(name, pos, kw, info) sets info.src to the weakest source of the arguments it used
// (code < config), or null when it used no value (a layer with no parameters). A bool or None argument is
// not tracked (pyscan.py cannot tag bools), so it neither lowers nor raises the source.

export class Unknown extends Error {}

const SIGS = {
  Linear: ['in_features', 'out_features', 'bias'],
  Bilinear: ['in1_features', 'in2_features', 'out_features', 'bias'],
  LayerNorm: ['normalized_shape', 'eps', 'elementwise_affine', 'bias'],
  RMSNorm: ['normalized_shape', 'eps', 'elementwise_affine'],
  GroupNorm: ['num_groups', 'num_channels', 'eps', 'affine'],
  BatchNorm: ['num_features', 'eps', 'momentum', 'affine', 'track_running_stats'],
  InstanceNorm: ['num_features', 'eps', 'momentum', 'affine', 'track_running_stats'],
  Embedding: ['num_embeddings', 'embedding_dim'],
  Conv: ['in_channels', 'out_channels', 'kernel_size', 'stride', 'padding', 'dilation', 'groups', 'bias'],
  ConvTranspose: ['in_channels', 'out_channels', 'kernel_size', 'stride', 'padding', 'output_padding', 'groups', 'bias', 'dilation'],
  MultiheadAttention: ['embed_dim', 'num_heads', 'dropout', 'bias', 'add_bias_kv', 'add_zero_attn', 'kdim', 'vdim'],
  PReLU: ['num_parameters', 'init'],
};

const NO_PARAMS = new Set(('Sequential ModuleList ModuleDict ReLU ReLU6 LeakyReLU ELU SELU CELU GELU SiLU Mish Tanh Sigmoid Softmax Softmax2d LogSoftmax Softplus Softsign ' +
  'Hardtanh Hardswish Hardsigmoid Hardshrink Softshrink Tanhshrink Threshold GLU LogSigmoid Dropout Dropout1d Dropout2d Dropout3d AlphaDropout ' +
  'FeatureAlphaDropout Identity Flatten Unflatten MaxPool1d MaxPool2d MaxPool3d AvgPool1d AvgPool2d AvgPool3d AdaptiveAvgPool1d AdaptiveAvgPool2d ' +
  'AdaptiveAvgPool3d AdaptiveMaxPool1d AdaptiveMaxPool2d AdaptiveMaxPool3d LPPool1d LPPool2d Upsample UpsamplingNearest2d UpsamplingBilinear2d ' +
  'ZeroPad1d ZeroPad2d ZeroPad3d ConstantPad1d ConstantPad2d ConstantPad3d ReflectionPad1d ReflectionPad2d ReflectionPad3d ReplicationPad1d ' +
  'ReplicationPad2d ReplicationPad3d PixelShuffle PixelUnshuffle ChannelShuffle CosineSimilarity PairwiseDistance LocalResponseNorm Fold Unfold ' +
  'MSELoss L1Loss CrossEntropyLoss BCELoss BCEWithLogitsLoss NLLLoss SmoothL1Loss HuberLoss KLDivLoss').split(' '));

/** The value of a recorded argument, or throws Unknown. rec is { v, at } from pyscan. */
function value(rec, what) {
  const v = rec?.v;
  if (v && typeof v === 'object' && !Array.isArray(v)) throw new Unknown(what + ' is not known: ' + (v.unknown || JSON.stringify(v)));
  return v;
}
function int(rec, what) {
  const v = value(rec, what);
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) throw new Unknown(what + ' is not an integer');
  return v;
}
function bool(rec, dflt, what) {
  if (rec === undefined) return dflt;
  const v = value(rec, what);
  if (typeof v !== 'boolean' && v !== 0 && v !== 1) throw new Unknown(what + ' is not a bool');
  return !!v;
}
function ints(rec, what, dims) {
  const v = value(rec, what);
  const arr = Array.isArray(v) ? v : [v];
  if (!arr.length || arr.some((x) => typeof x !== 'number' || !Number.isInteger(x))) throw new Unknown(what + ' is not an integer or a list of integers');
  return Array.isArray(v) || !dims ? arr : Array(dims).fill(v);
}
const prod = (a) => a.reduce((s, x) => s * x, 1);

/** pick(names)(pos, kw): the record of argument i by name or by position. Records that are read go into used. */
function pick(sig, pos, kw, used) {
  return (name) => {
    const r = kw && kw[name] !== undefined ? kw[name] : pos && pos[sig.indexOf(name)];
    if (r !== undefined && used) used.push(r);
    return r;
  };
}

const RANK = { code: 0, config: 1, weights: 2, run: 3 };
/** The weakest source of the records used, or null when none carries a tracked value. */
export function sourceOf(recs) {
  let w = null;
  for (const r of recs) {
    const v = r?.v;
    if (typeof v === 'boolean' || v === null || v === undefined) continue;
    const s = r.src || 'code';
    if (w === null || RANK[s] < RANK[w]) w = s;
  }
  return w;
}

function family(name) {
  const m = /^(BatchNorm|InstanceNorm|Conv|ConvTranspose)([123])d$/.exec(name);
  if (m) return [m[1], +m[2]];
  if (name === 'SyncBatchNorm') return ['BatchNorm', 1];
  return null;
}

/** Parameters of one layer: a number, or throws Unknown(reason). info.src gets the weakest source used. */
export function layerParams(name, pos = [], kw = {}, info = null) {
  const used = [];
  const n = count(name, pos, kw, used);
  if (info) info.src = sourceOf(used);
  return n;
}

function count(name, pos, kw, used) {
  if (NO_PARAMS.has(name)) return 0;
  const fam = family(name);
  const base = fam ? fam[0] : name;
  const sig = SIGS[base];
  if (!sig) throw new Unknown('torch.nn.' + name + ' is not in the layer table');
  const a = pick(sig, pos, kw, used);
  switch (base) {
    case 'Linear': return int(a('in_features'), 'in_features') * int(a('out_features'), 'out_features') + (bool(a('bias'), true, 'bias') ? int(a('out_features'), 'out_features') : 0);
    case 'Bilinear': return int(a('in1_features'), 'in1_features') * int(a('in2_features'), 'in2_features') * int(a('out_features'), 'out_features') + (bool(a('bias'), true, 'bias') ? int(a('out_features'), 'out_features') : 0);
    case 'LayerNorm': {
      if (!bool(a('elementwise_affine'), true, 'elementwise_affine')) return 0;
      return prod(ints(a('normalized_shape'), 'normalized_shape')) * (1 + (bool(a('bias'), true, 'bias') ? 1 : 0));
    }
    case 'RMSNorm': return bool(a('elementwise_affine'), true, 'elementwise_affine') ? prod(ints(a('normalized_shape'), 'normalized_shape')) : 0;
    case 'GroupNorm': return bool(a('affine'), true, 'affine') ? 2 * int(a('num_channels'), 'num_channels') : 0;
    case 'BatchNorm': return bool(a('affine'), true, 'affine') ? 2 * int(a('num_features'), 'num_features') : 0;
    case 'InstanceNorm': return bool(a('affine'), false, 'affine') ? 2 * int(a('num_features'), 'num_features') : 0;
    case 'Embedding': return int(a('num_embeddings'), 'num_embeddings') * int(a('embedding_dim'), 'embedding_dim');
    case 'PReLU': return a('num_parameters') === undefined ? 1 : int(a('num_parameters'), 'num_parameters');
    case 'Conv':
    case 'ConvTranspose': {
      const dims = fam[1];
      const cin = int(a('in_channels'), 'in_channels'), cout = int(a('out_channels'), 'out_channels');
      const groups = a('groups') === undefined ? 1 : int(a('groups'), 'groups');
      const k = prod(ints(a('kernel_size'), 'kernel_size', dims));
      const w = base === 'Conv' ? cout * (cin / groups) * k : cin * (cout / groups) * k;
      if (!Number.isInteger(w)) throw new Unknown('channels are not divisible by groups');
      return w + (bool(a('bias'), true, 'bias') ? cout : 0);
    }
    case 'MultiheadAttention': {
      const e = int(a('embed_dim'), 'embed_dim');
      const bias = bool(a('bias'), true, 'bias');
      const kd = a('kdim') === undefined || a('kdim').v === null ? e : int(a('kdim'), 'kdim');
      const vd = a('vdim') === undefined || a('vdim').v === null ? e : int(a('vdim'), 'vdim');
      const inProj = kd === e && vd === e ? 3 * e * e : e * e + e * kd + e * vd;
      return inProj + (bias ? 3 * e : 0) + e * e + (bias ? e : 0) + (bool(a('add_bias_kv'), false, 'add_bias_kv') ? 2 * e : 0);
    }
  }
  throw new Unknown('torch.nn.' + name + ' is not in the layer table');
}

/** The parameters of the weight alone (not the bias): what a layer loses when it shares its weight. */
export function weightParams(name, pos = [], kw = {}) {
  const base = family(name)?.[0] || name;
  const a = pick(SIGS[base] || [], pos, kw);
  if (base === 'Linear') return int(a('in_features'), 'in_features') * int(a('out_features'), 'out_features');
  if (base === 'Embedding') return int(a('num_embeddings'), 'num_embeddings') * int(a('embedding_dim'), 'embedding_dim');
  if (base === 'LayerNorm') return bool(a('elementwise_affine'), true, 'elementwise_affine') ? prod(ints(a('normalized_shape'), 'normalized_shape')) : 0;
  throw new Unknown('the weight of torch.nn.' + name + ' is not in the layer table');
}

/**
 * The state_dict entries of one layer: [{ key, shape, buffer? }], or throws Unknown(reason).
 * key is relative to the layer path. A buffer (running statistics) may be in a file but is not required.
 */
export function layerKeys(name, pos = [], kw = {}) {
  if (NO_PARAMS.has(name)) return [];
  const fam = family(name);
  const base = fam ? fam[0] : name;
  const sig = SIGS[base];
  if (!sig) throw new Unknown('torch.nn.' + name + ' is not in the layer table');
  const a = pick(sig, pos, kw);
  const K = (key, shape) => ({ key, shape });
  const buf = (key, shape) => ({ key, shape, buffer: true });
  const withBias = (dflt) => bool(a('bias'), dflt, 'bias');
  switch (base) {
    case 'Linear': {
      const i = int(a('in_features'), 'in_features'), o = int(a('out_features'), 'out_features');
      return [K('weight', [o, i]), ...(withBias(true) ? [K('bias', [o])] : [])];
    }
    case 'Bilinear': {
      const o = int(a('out_features'), 'out_features');
      return [K('weight', [o, int(a('in1_features'), 'in1_features'), int(a('in2_features'), 'in2_features')]), ...(withBias(true) ? [K('bias', [o])] : [])];
    }
    case 'LayerNorm': {
      if (!bool(a('elementwise_affine'), true, 'elementwise_affine')) return [];
      const ns = ints(a('normalized_shape'), 'normalized_shape');
      return [K('weight', ns), ...(withBias(true) ? [K('bias', ns)] : [])];
    }
    case 'RMSNorm': return bool(a('elementwise_affine'), true, 'elementwise_affine') ? [K('weight', ints(a('normalized_shape'), 'normalized_shape'))] : [];
    case 'GroupNorm': {
      if (!bool(a('affine'), true, 'affine')) return [];
      const c = int(a('num_channels'), 'num_channels');
      return [K('weight', [c]), K('bias', [c])];
    }
    case 'BatchNorm':
    case 'InstanceNorm': {
      const c = int(a('num_features'), 'num_features');
      const bn = base === 'BatchNorm';
      const out = bool(a('affine'), bn, 'affine') ? [K('weight', [c]), K('bias', [c])] : [];
      if (bool(a('track_running_stats'), bn, 'track_running_stats')) out.push(buf('running_mean', [c]), buf('running_var', [c]), buf('num_batches_tracked', []));
      return out;
    }
    case 'Embedding': return [K('weight', [int(a('num_embeddings'), 'num_embeddings'), int(a('embedding_dim'), 'embedding_dim')])];
    case 'PReLU': return [K('weight', [a('num_parameters') === undefined ? 1 : int(a('num_parameters'), 'num_parameters')])];
    case 'Conv':
    case 'ConvTranspose': {
      const cin = int(a('in_channels'), 'in_channels'), cout = int(a('out_channels'), 'out_channels');
      const groups = a('groups') === undefined ? 1 : int(a('groups'), 'groups');
      const k = ints(a('kernel_size'), 'kernel_size', fam[1]);
      const w = base === 'Conv' ? [cout, cin / groups, ...k] : [cin, cout / groups, ...k];
      if (!Number.isInteger(w[1])) throw new Unknown('channels are not divisible by groups');
      return [K('weight', w), ...(withBias(true) ? [K('bias', [cout])] : [])];
    }
    case 'MultiheadAttention': {
      const e = int(a('embed_dim'), 'embed_dim');
      const bias = withBias(true);
      const kd = a('kdim') === undefined || a('kdim').v === null ? e : int(a('kdim'), 'kdim');
      const vd = a('vdim') === undefined || a('vdim').v === null ? e : int(a('vdim'), 'vdim');
      const out = kd === e && vd === e ? [K('in_proj_weight', [3 * e, e])] : [K('q_proj_weight', [e, e]), K('k_proj_weight', [e, kd]), K('v_proj_weight', [e, vd])];
      if (bias) out.push(K('in_proj_bias', [3 * e]));
      out.push(K('out_proj.weight', [e, e]));
      if (bias) out.push(K('out_proj.bias', [e]));
      if (bool(a('add_bias_kv'), false, 'add_bias_kv')) out.push(K('bias_k', [1, 1, e]), K('bias_v', [1, 1, e]));
      return out;
    }
  }
  throw new Unknown('torch.nn.' + name + ' is not in the layer table');
}

export const knownLayers = () => [...NO_PARAMS, ...Object.keys(SIGS)];
