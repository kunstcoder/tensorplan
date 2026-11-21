from torch import nn


class Plain(nn.Module):
    def __init__(self, dim=16, heads=2):
        super().__init__()
        self.heads = heads
        self.fc = nn.Linear(dim, dim * heads)

    def forward(self, x):
        y = self.fc(x)
        if self.training:
            return dict(out=y, aux=x)
        return {"out": y, "extra": x}
