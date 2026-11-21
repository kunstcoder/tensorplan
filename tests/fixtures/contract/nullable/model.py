from typing import Optional, Union

import torch
from torch import nn


class Nullable(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc = nn.Linear(2, 2)

    def forward(
        self,
        required_or_none: torch.Tensor | None,
        none_first: None | torch.Tensor,
        five=5,
        both: Optional[int] = None,
        *,
        kw_union: Union[int, None],
        kw_plain: int = 3,
    ):
        return self.fc(required_or_none)
