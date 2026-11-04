"""每日总结统一读取：CLI、MCP与当前客户端使用完整报告。"""
import json
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest
import yaml

ROOT=Path(__file__).resolve().parents[1]
DAY='2026-10-31'
REPORT_FIELDS={'day','generatedAt','sourceCount','sourceActivityCount','generationId','sourceHash','response'}

class DailyReviewProtocolTests(unittest.TestCase):
    def test_cli_mcp_and_state_read_full_report_without_rewriting_file(self):
        """读取已保存的两份报告；完整字段和正文保持一致，源文件保持原字节。"""
        parent=ROOT/'tmp/daily-review-single-protocol';parent.mkdir(parents=True,exist_ok=True)
        for extended in (False,True):
            with self.subTest(extended=extended),tempfile.TemporaryDirectory(dir=parent) as folder:
                home=Path(folder)/'home';target=home/'daily-reviews'/f'{DAY}.json';target.parent.mkdir(parents=True)
                report=dict(day=DAY,generatedAt='2026-11-01T09:43:52+08:00',sourceCount=16,sourceHash='a'*64,response='【测试数据】31号已保存的完整日报告。\n\n旧报告原文保持。')
                if extended:report.update(sourceActivityCount=12,generationId='original-generation-id')
                target.write_text(json.dumps(report,ensure_ascii=False));before=target.read_bytes()
                config=yaml.safe_load((ROOT/'observer.yaml').read_text());config['home']=str(home);config['screenshotDir']=str(Path(folder)/'screens')
                config['kmhLauncher']=str(Path(folder)/'unavailable-model.mjs')
                config_path=Path(folder)/'observer.yaml';config_path.write_text(yaml.safe_dump(config,allow_unicode=True))
                def call(*args):
                    process=subprocess.run([sys.executable,'-B','-m','scening.daily_review','--config',str(config_path),'--day',DAY,*args],cwd=ROOT,env=dict(os.environ,PYTHONPATH=str(ROOT/'src')),capture_output=True,text=True,check=True)
                    return json.loads(process.stdout)
                reply=call('--cached-only')
                self.assertEqual(reply['status'],'ready')
                self.assertEqual(set(reply['review']),REPORT_FIELDS)
                self.assertEqual(reply['review']['response'],report['response'])
                from scening.mcp_server import call_tool
                from scening.observer_config import load_config
                mcp_text,is_error=call_tool(load_config(config_path),'generate_daily_review',{'day':DAY})
                self.assertFalse(is_error)
                self.assertEqual(json.loads(mcp_text),reply)
                full=call('--action','inspect')
                self.assertEqual(reply['review']['sourceActivityCount'],12 if extended else None)
                self.assertEqual(reply['review']['generationId'],'original-generation-id' if extended else None)
                self.assertEqual(full['report'],reply['review'])
                self.assertEqual(full['report']['sourceActivityCount'],12 if extended else None)
                self.assertEqual(full['report']['generationId'],'original-generation-id' if extended else None)
                self.assertEqual(full['report']['response'],report['response'])
                self.assertEqual(target.read_bytes(),before)
                self.assertFalse((home/'daily-review-status').exists())
                self.assertFalse((home/'kmh').exists())

    def test_single_cli_keeps_empty_error_and_rejects_retired_version_option(self):
        """缓存缺失与非法日期保持完整空/失败封套；已移除的版本参数由CLI拒绝。"""
        parent=ROOT/'tmp/daily-review-single-protocol';parent.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as folder:
            config=yaml.safe_load((ROOT/'observer.yaml').read_text());config['home']=str(Path(folder)/'home');config['screenshotDir']=str(Path(folder)/'screens')
            config_path=Path(folder)/'observer.yaml';config_path.write_text(yaml.safe_dump(config,allow_unicode=True))
            for day,status in [(DAY,'empty'),('2026-02-30','error')]:
                process=subprocess.run([sys.executable,'-B','-m','scening.daily_review','--config',str(config_path),'--day',day,'--cached-only'],cwd=ROOT,env=dict(os.environ,PYTHONPATH=str(ROOT/'src')),capture_output=True,text=True,check=True)
                value=json.loads(process.stdout)
                self.assertEqual(value['status'],status)
                self.assertEqual(set(value),{'status','message'})
                self.assertTrue(value['message'])

            removed=subprocess.run([sys.executable,'-B','-m','scening.daily_review','--config',str(config_path),'--day',DAY,'--cached-only','--reply-version','1'],cwd=ROOT,env=dict(os.environ,PYTHONPATH=str(ROOT/'src')),capture_output=True,text=True)
            self.assertEqual(removed.returncode,2)
            self.assertIn('unrecognized arguments',removed.stderr)
