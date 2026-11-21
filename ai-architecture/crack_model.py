# -*- coding: utf-8 -*-
"""
crack_model.py —— 面向细裂缝的小型分割网络（全分辨率 + 空洞卷积）

设计约束（每条都对应一个具体失效模式）：
  1. **不下采样**：裂缝常只有 2~3px，缩短 4 倍就没了。
  2. **空洞卷积扩大感受野**：不缩小图也能看到上下文（Yu & Koltun, ICLR 2016）。
     注意：空洞率**不增加任何参数**，只加计算量，所以是"免费"的视野。
  3. **1 通道灰度**：裂缝是亮度特征，颜色无用，省 2/3 输入算力。
  4. **参数量约 4.5 万**：U-Net 的 0.6%。可跑 CPU、可塞进容器。
  5. **输出 logits**：不在模型里做 sigmoid，交给损失函数（数值更稳）。
"""
import torch
import torch.nn as nn

# 逐级扩大的空洞率：感受野 1 → 3 → 7 → 15 → 31 → 33
DILATIONS = (1, 2, 4, 8)


def conv_bn(cin, cout, dilation=1):
    """3x3 卷积 + BN + ReLU。padding 随 dilation 调整，保证尺寸不变。"""
    return nn.Sequential(
        nn.Conv2d(cin, cout, 3, padding=dilation, dilation=dilation, bias=False),
        nn.BatchNorm2d(cout),
        nn.ReLU(inplace=True),
    )


class CrackNet(nn.Module):
    """全分辨率空洞卷积分割网络。

        conv3x3(1  → c1, d=1)   RF 3
        conv3x3(c1 → c1, d=2)   RF 7
        conv3x3(c1 → c1, d=4)   RF 15
        conv3x3(c1 → c2, d=8)   RF 31
        conv3x3(c2 → c2, d=1)   RF 33   融合，不再扩视野
        conv1x1(c2 → 1)                 输出 logits
    """

    def __init__(self, c1=28, c2=44, dilations=DILATIONS):
        super().__init__()
        self.dilations = tuple(dilations)
        self.stem = conv_bn(1, c1, dilation=self.dilations[0])
        self.blocks = nn.ModuleList(
            [conv_bn(c1, c1, self.dilations[1]),
             conv_bn(c1, c1, self.dilations[2]),
             conv_bn(c1, c2, self.dilations[3])]
        )
        self.fuse = conv_bn(c2, c2, dilation=1)
        self.head = nn.Conv2d(c2, 1, 1)

    def forward(self, x):
        x = self.stem(x)
        for b in self.blocks:
            x = b(x)
        x = self.fuse(x)
        return self.head(x)

    def receptive_field(self):
        """精确感受野：每层 3x3 加 2d，1x1 加 0。"""
        rf = 1
        for d in self.dilations:
            rf += 2 * d
        rf += 2 * 1        # fuse 层 d=1
        return rf


def print_summary(model=None):
    m = model or CrackNet()
    total = sum(p.numel() for p in m.parameters())
    print("参数量：%d（可训练 %d）" % (total, sum(p.numel() for p in m.parameters() if p.requires_grad)))
    print("模型大小（float32）：%.1f KB" % (total * 4 / 1024))
    print()
    print("%-12s %-10s %s" % ("层", "参数量", "占比"))
    print("-" * 40)
    for name, mod in m.named_children():
        if not hasattr(mod, "parameters"):
            continue
        n = sum(p.numel() for p in mod.parameters())
        print("%-12s %-10d %.1f%%" % (name, n, n / total * 100))
    print()
    print("精确感受野：%d px（全程未缩小图像）" % m.receptive_field())
    return total


if __name__ == "__main__":
    m = CrackNet()
    n = print_summary(m)
    x = torch.randn(2, 1, 192, 192)
    with torch.no_grad():
        y = m(x)
    print()
    print("前向：%s → %s  %s"
          % (tuple(x.shape), tuple(y.shape),
             "尺寸一致 OK" if y.shape[-2:] == x.shape[-2:] else "尺寸不符!"))
    ok = 40000 <= n <= 50000
    print("参数量落在 40k~50k：%s（%d）" % ("是" if ok else "否", n))
    raise SystemExit(0 if ok else 1)
