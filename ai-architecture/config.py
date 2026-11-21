# -*- coding: utf-8 -*-
"""
================================================================
 config.py —— 知乎建筑认知分析系统 · 统一配置模块
================================================================
 本模块集中管理全部可配置项：
   1. 密钥读取（环境变量 / .env 文件，源码中不硬编码密钥）
   2. 知乎 API 相关配置
   3. 搜索关键词组（AI 问题拆解后自动生成）
   4. 建筑相关性评分权重（五维评分模型）
   5. 无关内容黑名单
   6. 输出目录
 说明：
   - .env 文件存放真实密钥，已被 .gitignore 忽略
   - 运行前请复制 .env.example 为 .env 并填写密钥
================================================================
"""

import os
import sys
import threading

# =========================================================
# 0. 统一输出编码
#    防止在 Windows 默认 GBK 终端下输出 emoji/特殊符号时
#    抛出 UnicodeEncodeError。所有模块都 import config，
#    因此在这里统一配置即可全局生效。
# =========================================================
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass  # 部分环境不支持 reconfigure 时静默跳过


# =========================================================
# 1. 轻量 .env 文件加载（使用标准库，避免额外依赖）
#    规则：KEY=VALUE，支持 # 注释；系统环境变量优先
# =========================================================
def _load_dotenv(path: str = ".env") -> None:
    """从 .env 文件中读取键值对到环境变量（若环境变量已存在则跳过）。"""
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            # 已存在的环境变量优先，不覆盖
            os.environ.setdefault(key, value)


# 加载当前目录下的 .env
_load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))


# =========================================================
# 2. 知乎开放平台配置
# =========================================================
# 密钥从环境变量读取（.env 中填写），源码不硬编码
ZHIHU_ACCESS_SECRET = os.environ.get("ZHIHU_ACCESS_SECRET", "")

# 知乎 provider：api 使用现有 HTTP 接入，cli 使用官方 zhihu-cli Skill
ZHIHU_PROVIDER = os.environ.get("ZHIHU_PROVIDER", "cli").strip().lower()

# 知乎搜索接口地址
ZHIHU_API_URL = os.environ.get(
    "ZHIHU_API_URL",
    "https://developer.zhihu.com/api/v1/content/zhihu_search",
)

# 网络请求超时时间（秒）
REQUEST_TIMEOUT = 30

# 请求失败最大重试次数
MAX_RETRY = 3

# 两次请求之间的最小间隔（秒），用于控制请求频率
# 知乎开放平台限流严格，默认按 5 秒/次 调用
REQUEST_INTERVAL = 5.0


# =========================================================
# 3. 搜索关键词组
#    对应流程「第二步：自动生成知乎搜索任务」
#    可针对不同园区/主体在 config 中统一替换，无需改代码
# =========================================================
SEARCH_KEYWORDS = [
    # 主体 + 体验
    "方特 游客体验",
    "方特 游玩路线",
    "方特 动线",
    "方特 步行",
    "方特 距离",
    "方特 入口",
    "方特 景观",
    "方特 休息",
    "方特 排队",
    # 行业通用
    "主题乐园 游客体验",
    "主题乐园 动线",
    "主题乐园 入口设计",
]

# 单次抓取时使用的前 N 个关键词（避免请求过多触发限流）
KEYWORD_LIMIT = 5


# =========================================================
# 4. 建筑相关性评分权重（满分 100 分）
#    对应流程「第三步：建筑相关性评分系统」
# =========================================================
SCORE_WEIGHTS = {
    "relevance":      0.30,  # 相关性：是否围绕建筑/空间/动线等话题
    "specificity":    0.20,  # 具体性：是否有具体场景、地点、细节描述
    "experience":     0.20,  # 真实体验程度：是否为亲身体验、带有情绪/感受
    "frequency":      0.15,  # 重复出现次数：同类问题被多少人提到
    "convertibility": 0.15,  # 设计可转换性：能否转换为可执行的建筑问题/设计方向
}

# 建筑数据准入阈值：总分 >= 该值 才进入建筑分析
ADMISSION_THRESHOLD = 60.0


# =========================================================
# 5. 大模型接入配置（模块4 AI 文本分析 + 客户问答智能拆解）
#    支持服务商：deepseek（默认）/ doubao（豆包·火山方舟，OpenAI 兼容协议）
# =========================================================
# 是否启用大模型分析（True=启用；False=仅规则引擎）
AI_ENABLED = True

# 服务商选择：deepseek | doubao（非法值回退 deepseek）
AI_PROVIDER = os.environ.get("AI_PROVIDER", "deepseek").strip().lower()
if AI_PROVIDER not in ("deepseek", "doubao"):
    AI_PROVIDER = "deepseek"

# --- 自定义 OpenAI 兼容接口（默认停用；启用且字段完整时优先用于 AI 对话）---
CUSTOM_API_NAME = os.environ.get("CUSTOM_API_NAME", "").strip()
CUSTOM_API_BASE_URL = os.environ.get("CUSTOM_API_BASE_URL", "").strip()
CUSTOM_API_MODEL = os.environ.get("CUSTOM_API_MODEL", "").strip()
CUSTOM_API_KEY = os.environ.get("CUSTOM_API_KEY", "")
CUSTOM_API_ENABLED = os.environ.get("CUSTOM_API_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")

# --- DeepSeek ---
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")

# --- 豆包 / 火山方舟（OpenAI 兼容：https://ark.cn-beijing.volces.com/api/v3）---
DOUBAO_API_KEY = os.environ.get("DOUBAO_API_KEY", "")
DOUBAO_BASE_URL = os.environ.get(
    "DOUBAO_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"
)
# 模型名或推理接入点 ID（ep-xxxx），以火山方舟控制台为准
DOUBAO_MODEL = os.environ.get("DOUBAO_MODEL", "")

# 大模型批量分析参数
AI_BATCH_SIZE = 5      # 每次请求最多分析的条数（控制单次 token，降低超时风险）
AI_MAX_ITEMS = 10      # 每轮最多用大模型精析的准入条数（控制成本，超出部分走规则引擎）
AI_TIMEOUT = 180       # 单次请求超时时间（秒）

# AI 运行模式：
#   single = 仅用 AI_PROVIDER 指定的主模型
#   dual   = DeepSeek + 豆包 双模型同批分析，合并结果（共识/分歧标记）
#            —— 提高正确率，但每次精析消耗两家各一次请求（默认 single 控成本）
AI_MODE = os.environ.get("AI_MODE", "single").strip().lower()
if AI_MODE not in ("single", "dual"):
    AI_MODE = "single"


# ---------------------------------------------------------
# 5.1 当前生效的大模型服务商配置（ai_analyzer / intake_parser 统一使用）
# ---------------------------------------------------------
# 请求级 AI 配置覆盖（线程局部）：网页版把访客配置随单次请求传入，
# 服务端在独立线程内 set 后调用，用完 clear，天然互不干扰、不落盘。
# 桌面版从不调用 set_ai_override，行为与历史完全一致。
_AI_OVERRIDE = threading.local()


def set_ai_override(cfg) -> None:
    """设置当前线程的 AI 配置覆盖；传 None 或空 dict 清除。"""
    _AI_OVERRIDE.value = dict(cfg) if cfg else None


def get_ai_override():
    """返回当前线程的覆盖配置；无则 None。"""
    return getattr(_AI_OVERRIDE, "value", None)


def clear_ai_override() -> None:
    """清除当前线程的覆盖配置。"""
    _AI_OVERRIDE.value = None


def _provider_config(name: str) -> dict:
    """返回单家服务商的配置（不含 name 键）。"""
    if name == "doubao":
        return {
            "api_key": DOUBAO_API_KEY,
            "base_url": DOUBAO_BASE_URL,
            "model": DOUBAO_MODEL,
        }
    return {
        "api_key": DEEPSEEK_API_KEY,
        "base_url": DEEPSEEK_BASE_URL,
        "model": DEEPSEEK_MODEL,
    }


def get_ai_configs() -> list:
    """
    返回本批要调用的服务商配置列表（含 name 键），按使用顺序排列：
      - single：只有主模型（AI_PROVIDER 指定）；
      - dual：主模型在前、另一家在后；某家未配 Key 时自动跳过。
    两家都未配 Key 时返回空列表（上层走规则引擎）。

    有线程级覆盖时，返回 [覆盖]（覆盖是单条配置，不走 dual）。
    """
    ov = get_ai_override()
    if ov:
        cfg = dict(ov)
        cfg.setdefault("name", ov.get("name") or "custom")
        cfg.setdefault("custom", True)
        return [cfg]

    primary = "doubao" if AI_PROVIDER == "doubao" else "deepseek"
    other = "deepseek" if primary == "doubao" else "doubao"
    order = [primary, other] if AI_MODE == "dual" else [primary]

    cfgs = []
    for name in order:
        cfg = _provider_config(name)
        if cfg["api_key"]:
            cfg = dict(cfg)
            cfg["name"] = name
            cfgs.append(cfg)
    return cfgs


def get_custom_ai_config() -> dict:
    """返回自定义 OpenAI 兼容接口；未启用或字段不完整时返回空字典。
    有线程级覆盖时优先返回覆盖（带 custom: True）。"""
    ov = get_ai_override()
    if ov:
        return {"name": ov.get("name") or "custom", "api_key": ov.get("api_key", ""),
                "base_url": ov.get("base_url", ""), "model": ov.get("model", ""), "custom": True}
    if CUSTOM_API_ENABLED and CUSTOM_API_BASE_URL and CUSTOM_API_MODEL and CUSTOM_API_KEY:
        return {"name": CUSTOM_API_NAME or "custom", "api_key": CUSTOM_API_KEY,
                "base_url": CUSTOM_API_BASE_URL, "model": CUSTOM_API_MODEL, "custom": True}
    return {}


def get_ai_config() -> dict:
    """
    返回主模型配置（兼容 intake_parser 等“单次调用”场景）。
    自定义 API 仅在显式启用且字段完整时优先；否则保持原有 provider 行为。
    有线程级覆盖时优先返回覆盖。
    """
    ov = get_ai_override()
    if ov:
        return {"name": ov.get("name") or "custom", "api_key": ov.get("api_key", ""),
                "base_url": ov.get("base_url", ""), "model": ov.get("model", ""), "custom": True}
    custom = get_custom_ai_config()
    if custom:
        return custom
    cfgs = get_ai_configs()
    if cfgs:
        return cfgs[0]
    name = "doubao" if AI_PROVIDER == "doubao" else "deepseek"
    cfg = _provider_config(name)
    cfg["name"] = name
    return cfg


def ai_key_env_name() -> str:
    """当前服务商对应的密钥环境变量名（用于提示文案）。"""
    return "DOUBAO_API_KEY" if AI_PROVIDER == "doubao" else "DEEPSEEK_API_KEY"


# =========================================================
# 6. 输出目录
# =========================================================
# 项目根目录
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# 运行结果输出目录（原始数据 / 结构化分析结果）
OUTPUT_DIR = os.path.join(BASE_DIR, "output")
# 前端页面目录
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")


# =========================================================
# 7. 运行前自检
#    Bug-2 修复：DeepSeek Key 是可选项（失败自动回退规则引擎），
#    只有知乎 Access Secret 缺失才阻断流程。
# =========================================================
def check_config() -> list:
    """
    检查关键配置是否齐全，返回【致命缺失】列表（空列表表示可运行）。
    注意：DEEPSEEK_API_KEY 缺失不算致命——ai_analyzer.py 会在未配置
    或调用失败时自动回退规则引擎，保证流程始终可跑通。
    """
    missing = []
    if not ZHIHU_ACCESS_SECRET:
        missing.append("ZHIHU_ACCESS_SECRET（请在 .env 中填写知乎 Access Secret）")
    return missing


def check_config_warnings() -> list:
    """返回非致命配置提示（例如启用 AI 但缺少 DeepSeek Key）。"""
    warnings = []
    if AI_ENABLED:
        if AI_MODE == "dual":
            missing = [
                n for n in ("deepseek", "doubao")
                if not _provider_config(n)["api_key"]
            ]
            for n in missing:
                env_key = "DOUBAO_API_KEY" if n == "doubao" else "DEEPSEEK_API_KEY"
                if len(missing) == 2:
                    warnings.append(
                        f"{env_key} 等大模型 Key 均未配置：AI 文本精析将回退规则引擎"
                    )
                else:
                    warnings.append(
                        f"{env_key} 未配置：双模型模式退化为单模型"
                    )
        else:
            cfg = get_ai_config()
            if not cfg["api_key"]:
                warnings.append(
                    f"{ai_key_env_name()} 未配置"
                    f"（当前 AI_PROVIDER={AI_PROVIDER}）："
                    "AI 文本精析将自动回退规则引擎"
                )
        if DOUBAO_API_KEY and not DOUBAO_MODEL:
            warnings.append(
                "DOUBAO_MODEL 未配置：请填模型名或火山方舟推理接入点 ID（ep-xxxx）"
            )
    return warnings
