"""A small fixture for the modelmap scan tests. It is read as text. It is never imported or run."""
import torch
from torch import nn
from timm.layers import DropPath


class Mlp(nn.Module):
    def __init__(self, dim, ratio=4):
        super().__init__()
        self.fc1 = nn.Linear(dim, dim * ratio)
        self.act = nn.GELU()
        self.fc2 = nn.Linear(dim * ratio, dim)


class Attn(nn.Module):
    def __init__(self, dim, heads=2):
        super().__init__()
        self.qkv = nn.Linear(dim, dim * 3)
        self.proj = nn.Linear(dim, dim)


class CrossAttn(Attn):  # no __init__ of its own: it uses the one of Attn
    pass


class Block(nn.Module):
    def __init__(self, dim, attn_ctor=Attn):
        super().__init__()
        self.norm1 = nn.LayerNorm(dim)
        self.attn = attn_ctor(dim)
        self.norm2 = nn.LayerNorm(dim)
        self.mlp = Mlp(dim)


class Net(nn.Module):
    def __init__(self, dim=16, depth=3, pattern="sc", out=4, use_pos=True, cfg=None):
        super().__init__()
        self.embed = nn.Embedding(100, dim)
        self.pos = nn.Parameter(torch.zeros(1, 8, dim)) if use_pos else None
        self.blocks = nn.ModuleList([Block(dim) for _ in range(depth)])
        self.mixed = nn.ModuleList()
        for ch in pattern:
            if ch == "s":
                ctor = Attn
            elif ch == "c":
                ctor = CrossAttn
            else:
                raise NotImplementedError
            self.mixed.append(Block(dim, attn_ctor=ctor))
        self.head = nn.Sequential(nn.Linear(dim, dim), nn.GELU(), nn.Linear(dim, out))
        self.tied = self.head[0]  # the same module under a second name
        self.extra = self._make(dim)
        self.drop = DropPath(0.1)  # a class from a package that is not in the repo
        self.mystery = make_layer(cfg.hidden)  # a call that cannot be known

    def _make(self, d):
        return nn.Linear(d, d)
