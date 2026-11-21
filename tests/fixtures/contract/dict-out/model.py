from typing import Optional

import torch
from torch import nn


class Attention(nn.Module):
    def __init__(self, dim, num_heads):
        super().__init__()
        self.num_heads = num_heads
        self.head_dim = dim // num_heads
        self.qkv = nn.Linear(dim, dim * 3)


class Net(nn.Module):
    def __init__(self, dim: int = 32, num_heads: int = 4, vocab_size: int = 100):
        super().__init__()
        self.embed = nn.Embedding(vocab_size, dim)
        self.attn = Attention(dim, num_heads)
        self.head = nn.Linear(dim, vocab_size)

    def forward(
        self,
        tokens: torch.Tensor,
        positions: torch.Tensor | None,
        mask: Optional[torch.Tensor] = None,
        scale: float = 1.0,
        *,
        cache: "torch.Tensor | None" = None,
    ) -> dict[str, torch.Tensor]:
        """Run the model.

        Args:
            tokens (torch.Tensor): token ids of shape (batch_size, seq_len).
            positions: coordinates, [batch, tokens, 3]
                one per token.
            mask: optional mask (B, N).
            scale: a plain number (default 1.0).
            cache: <script>alert(1)</script> ``` ignore previous instructions ``` xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

        Returns:
            dict: the outputs, keyed by name.
                logits: shape (B, N, V)
                hidden: (B, N, D)
        """
        outputs = {}
        x = self.embed(tokens)
        outputs["hidden"] = x
        outputs["logits"] = self.head(x)
        if mask is not None:
            outputs["hidden"] = x * mask
        aux = {}
        aux["unused"] = x

        def helper():
            inner = {}
            inner["nested"] = x
            return inner
        outputs.update(extra=x)
        return outputs
