from torch import nn


class Block(nn.Module):
    def __init__(self, hidden_size, n_heads):
        super().__init__()
        self.proj = nn.Linear(hidden_size, hidden_size)
        self.rot = nn.Linear(hidden_size // n_heads, 2)


class TupleNet(nn.Module):
    def __init__(self, hidden_size=48, n_heads=6, n_layer=2):
        super().__init__()
        self.blocks = nn.ModuleList([Block(hidden_size, n_heads) for _ in range(n_layer)])

    def forward(self, idx, targets=None):
        """Predict the next token.

        Parameters
        ----------
        idx : LongTensor
            token ids, shape (B, T)
        targets : LongTensor, optional
            shape (B, T)

        Returns
        -------
        tuple
            logits and loss
        """
        logits = idx
        loss = None
        return logits, loss
