# -*- coding: utf-8 -*-
"""
web/rate_limit.py —— 轻量限流骨架（2026-11-18 知筑收口）

三件事：
  1. 按 IP 每分钟限次
  2. 单 IP 每日总额度
  3. 全站每日熔断

配置方式（环境变量，不设 = 全关）：
  ZHIZHU_RATE_PER_MIN=10        每 IP 每分钟限 10 次
  ZHIZHU_RATE_PER_DAY=100       每 IP 每天限 100 次
  ZHIZHU_RATE_GLOBAL_DAY=500    全站每天限 500 次

⚠️ 多进程部署（gunicorn/uwsgi 多 worker）需要换共享存储（Redis 等），
   当前是内存实现，只保证单进程内有效。
"""
import os
import time


class RateLimiter:
    """内存限流器。默认全关（不设环境变量 = 不限流）。"""

    def __init__(self):
        self._ip_min = {}       # ip -> [timestamps in current minute]
        self._ip_day = {}       # ip -> [timestamps in current day]
        self._global_day = []   # [timestamps in current day]
        self._day_start = self._today_start()

    @staticmethod
    def _today_start():
        """今天 00:00 的 Unix 时间戳。"""
        now = time.time()
        return now - (now % 86400)

    def _reset_if_new_day(self):
        today = self._today_start()
        if today != self._day_start:
            self._day_start = today
            self._ip_day.clear()
            self._global_day.clear()

    @staticmethod
    def _load_int(env_name):
        val = os.environ.get(env_name, "").strip()
        if not val:
            return None
        try:
            n = int(val)
            return n if n > 0 else None
        except ValueError:
            return None

    def allow(self, ip):
        """返回 (allowed: bool, retry_after: float|None, reason: str|None)。
        不配置任何环境变量时永远放行。"""
        per_min = self._load_int("ZHIZHU_RATE_PER_MIN")
        per_day = self._load_int("ZHIZHU_RATE_PER_DAY")
        global_day = self._load_int("ZHIZHU_RATE_GLOBAL_DAY")

        # 全部未配置 → 不限流
        if per_min is None and per_day is None and global_day is None:
            return True, None, None

        self._reset_if_new_day()
        now = time.time()

        # 3. 全站每日熔断
        if global_day is not None:
            self._global_day = [t for t in self._global_day if t >= self._day_start]
            if len(self._global_day) >= global_day:
                retry = self._day_start + 86400 - now
                return False, retry, "全站今日请求已达上限"

        # 1. 按 IP 每分钟限次
        if per_min is not None:
            minute_ago = now - 60
            if ip not in self._ip_min:
                self._ip_min[ip] = []
            self._ip_min[ip] = [t for t in self._ip_min[ip] if t > minute_ago]
            if len(self._ip_min[ip]) >= per_min:
                oldest = min(self._ip_min[ip])
                retry = oldest + 60 - now
                return False, max(retry, 1), "请求过于频繁（每分钟限 %d 次）" % per_min

        # 2. 单 IP 每日总额度
        if per_day is not None:
            if ip not in self._ip_day:
                self._ip_day[ip] = []
            self._ip_day[ip] = [t for t in self._ip_day[ip] if t >= self._day_start]
            if len(self._ip_day[ip]) >= per_day:
                retry = self._day_start + 86400 - now
                return False, retry, "今日请求已达上限（每日限 %d 次）" % per_day

        # 记录本次请求
        if per_min is not None:
            self._ip_min.setdefault(ip, []).append(now)
        if per_day is not None:
            self._ip_day.setdefault(ip, []).append(now)
        if global_day is not None:
            self._global_day.append(now)

        return True, None, None


# 全局单例
_limiter = RateLimiter()


def allow(ip):
    """便捷入口：返回 True/False。"""
    ok, _, _ = _limiter.allow(ip)
    return ok


def allow_detail(ip):
    """返回 (allowed, retry_after_seconds, reason)。"""
    return _limiter.allow(ip)
