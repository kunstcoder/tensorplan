"""A small GPT-like fixture for the modelmap config and weights tests. It is read as text. It is never imported or run."""
from dataclasses import dataclass
import torch
from torch import nn


@dataclass
class Settings:
    vocab: int = 100
    context: int = 16
    layers: int = 2
    width: int = 8
    bias: bool = True


class Norm(nn.Module):
    def __init__(self, width, bias):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(width))
        self.bias = nn.Parameter(torch.zeros(width)) if bias else None


class SelfAttention(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.qkv = nn.Linear(cfg.width, 3 * cfg.width, bias=cfg.bias)
        self.out = nn.Linear(cfg.width, cfg.width, bias=cfg.bias)


class FeedForward(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.up = nn.Linear(cfg.width, 4 * cfg.width, bias=cfg.bias)
        self.act = nn.GELU()
        self.down = nn.Linear(4 * cfg.width, cfg.width, bias=cfg.bias)


class Layer(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.norm1 = Norm(cfg.width, bias=cfg.bias)
        self.attn = SelfAttention(cfg)
        self.norm2 = Norm(cfg.width, bias=cfg.bias)
        self.ff = FeedForward(cfg)


class TinyGPT(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.body = nn.ModuleDict(dict(
            tok=nn.Embedding(cfg.vocab, cfg.width),
            pos=nn.Embedding(cfg.context, cfg.width),
            layers=nn.ModuleList([Layer(cfg) for _ in range(cfg.layers)]),
            norm=Norm(cfg.width, bias=cfg.bias),
        ))
        self.head = nn.Linear(cfg.width, cfg.vocab, bias=False)
        self.body.tok.weight = self.head.weight  # tied

    def forward(self, idx):
        return self.head(self.body.norm(idx))


class Wide(nn.Module):
    """Takes its values as plain arguments: a config reaches it only with --config-arg **."""

    def __init__(self, width, depth=1):
        super().__init__()
        self.blocks = nn.ModuleList([nn.Linear(width, width) for _ in range(depth)])

    def forward(self, x):
        return x
