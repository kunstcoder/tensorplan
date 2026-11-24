import torch
from torch import nn


class Block(nn.Module):
    """A pre-norm block with two residual additions.

    Args:
        dim: width of the tokens.
    """

    def __init__(self, dim, num_heads=2):
        super().__init__()
        self.norm1 = nn.LayerNorm(dim)
        self.attn = nn.Linear(dim, dim)
        self.norm2 = nn.LayerNorm(dim)
        self.mlp = nn.Linear(dim, dim)

    def forward(self, x):
        """x: (batch_size, num_tokens, dim)"""
        x = x + self.attn(self.norm1(x))
        x = x + self.mlp(self.norm2(x))
        return x


class Head(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.proj = nn.Sequential(nn.Linear(dim, dim), nn.GELU(), nn.Linear(dim, 2))
        self.out = nn.Linear(2, 2)

    def forward(self, x):
        return self.out(self.proj(x))


class Net(nn.Module):
    def __init__(self, dim=8, depth=3):
        super().__init__()
        self.blocks = nn.ModuleList([Block(dim) for _ in range(depth)])
        self.mixed = nn.ModuleList([Block(dim), Block(dim, num_heads=4), Block(dim)])
        self.head = Head(dim)

    def forward(self, x):
        for b in self.blocks:
            x = b(x)
        for b in self.mixed:
            x = b(x)
        return self.head(x)
