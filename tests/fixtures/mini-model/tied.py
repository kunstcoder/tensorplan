from dataclasses import dataclass
from torch import nn


def pair(t):
    return t if isinstance(t, tuple) else (t, t)


@dataclass
class Config:
    vocab: int = 50
    dim: int = 8
    layers: int = 2


class Tied(nn.Module):
    def __init__(self, config, size=4):
        super().__init__()
        h, w = pair(size)
        first, *rest = (1, 2, 3)
        self.embed = nn.Embedding(config.vocab, config.dim)
        self.stack = nn.ModuleList([nn.Linear(config.dim, config.dim) for _ in range(config.layers)])
        self.pool = nn.Linear(h * w * first * len(rest), config.dim, bias=False)
        self.out = nn.Linear(config.dim, config.vocab, bias=False)
        self.embed.weight = self.out.weight  # tied: one weight, two names
