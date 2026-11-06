#!/usr/bin/env python3
"""Exercise real Node publication frames with the real C firmware reducer."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PRODUCER = r'''
import {pathToFileURL} from 'node:url';
const {Model,Publication}=await import(pathToFileURL(process.argv[2]).href);
const mode=process.argv[3];
const model=new Model({now:()=>Date.parse('2026-11-05T12:00:00Z')});
const count=mode==='maximum'?16:2;
for(let i=0;i<count;i++)model.ingest({source_id:'magpie',session_id:'session-'+i,run_id:'run-'+i,revision:1,title:i===0?'你好，鲸鱼 🐳':'Agent '+i,entity_kind:'turn',execution_state:'running',pending_interactions:i===0?[{request_id:'question-'+i,revision:1,blocks_execution:false}]:[],task_outcome:null});
model.meter({id:'usage-session',revision:1,tokens:'900',scope:{source_id:'magpie',session_id:'session-0'},buckets:{input:100,output:200,cache_read:600,cache_write:0},model:'deepseek-v4-pro',decode:{tokens:770,ms:20000},money:{micros:'360000',currency:'CNY',provenance:'estimate'}});
const publication=new Publication('contract-test');
let frames=publication.snapshot(model.projection({publicMode:mode==='public'}));
if(mode==='correction'){
  model.meter({id:'usage-session',revision:2,tokens:'450'});
  frames.push(...publication.update(model.projection()));
}
for(const frame of frames)console.log(JSON.stringify(frame));
'''


@unittest.skipUnless(shutil.which('node'), 'Node.js is required for bridge interoperability')
class ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='agent-pet-contract-')
        cls.probe = Path(cls.directory.name) / 'probe'
        subprocess.run([os.environ.get('CC', 'cc'), '-std=c11', '-Wall', '-Wextra', '-Werror',
                        '-I', str(ROOT / 'main'), str(ROOT / 'tools/agent_pet_protocol_probe.c'),
                        str(ROOT / 'main/agent_pet_model.c'), '-o', str(cls.probe)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def consume(self, mode):
        frames = subprocess.run(['node', '--input-type=module', '-',
                                 str(ROOT / 'services/src/model.mjs'), mode],
                                input=PRODUCER, text=True, capture_output=True, check=True).stdout
        for line in frames.splitlines():
            self.assertLessEqual(len(line.encode()), 4096)
        result = subprocess.run([str(self.probe), 'contract-test'], input=frames,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_unicode_and_orthogonal_attention(self):
        state = self.consume('normal')
        self.assertEqual((state['tasks'], state['running'], state['waiting']), (2, 2, 1))
        self.assertEqual(state['tokens'], '900')

    def test_full_capacity_snapshot(self):
        self.assertEqual(self.consume('maximum')['tasks'], 16)

    def test_meter_replacement_can_reduce_total(self):
        state = self.consume('correction')
        self.assertEqual(state['tokens'], '450')
        self.assertEqual(state['revision'], 1)

    def test_public_projection_contains_no_task_or_usage(self):
        state = self.consume('public')
        self.assertEqual(state['tasks'], 0)
        self.assertFalse(state['usage_known'])


if __name__ == '__main__':
    unittest.main()
