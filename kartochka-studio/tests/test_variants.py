"""Offline regression checks; no API calls or credentials required."""
import copy
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import engine
import start

SOURCE={"id":"123","sku":"456","url":"https://uzum.uz/ru/product/test-123?skuId=456","title":"Qalamdon","description":"Stolusti qalamdon.","attributes":"","category":"Kanselyariya","photos":[],"keywords":[],"method":"manual"}
ANSWER={"model":"","brand":"","country":"","warranty":"","color_uz":"","color_ru":"","source_terms":[],"sku_root":"DEMO"}
for lang in ("uz","ru"):
    ANSWER[lang]={"title":"Qalamdon" if lang=="uz" else "Подставка","short":"Qisqa tavsif." if lang=="uz" else "Краткое описание.","full":"Asosiy tavsif." if lang=="uz" else "Основное описание.","composition":"Qalamdon." if lang=="uz" else "Подставка.","instructions":"Stolga qo‘ying." if lang=="uz" else "Поставьте на стол.","properties":[],"keyword_suggestions":[]}

def response():
    return {"output":[{"type":"message","content":[{"type":"output_text","text":json.dumps(ANSWER,ensure_ascii=False)}]}]}

class VariantTests(unittest.TestCase):
    def test_defaults_and_variant_validation(self):
        self.assertEqual([v['count'] for v in engine.generation_variants()],[1,2])
        bad=[[],[{'count':0}],[{'count':-1}],[{'count':True}],[{'count':1.5}],[{'count':'5'}],[{'count':10000}],[{'count':1}]*13,[{'count':1},{'count':1}],[{'count':1,'sku':'ABC'},{'count':2,'sku':'abc'}],[{'count':1,'sku':'a b'}],[{'count':1,'label_ru':'a'*61}]]
        for value in bad:
            with self.subTest(value=value),self.assertRaises(engine.Problem):engine.generation_variants(value)

    def test_custom_variant_names_and_sku_collisions(self):
        variants=engine.generation_variants([{'count':5,'label_uz':'Qora','label_ru':'Чёрный'},{'count':5,'label_uz':'Oq','label_ru':'Белый'},{'count':10,'sku':'DEMO-5'}])
        engine.assign_variant_skus(variants,'DEMO')
        self.assertEqual([v['sku'] for v in variants],['DEMO-5-2','DEMO-5-3','DEMO-5'])

    def test_generated_payload_and_managed_blocks(self):
        variants=[{'count':3,'sku':'MY-3','note_uz':'Kabel bilan','note_ru':'С кабелем'},{'count':10}]
        with patch.object(engine,'openai_request',return_value=response()) as api:
            card=engine.generate(SOURCE,'sk-offline-test-placeholder','sales','',False,engine.APP_MODEL,{'images':False,'properties':False},variants)
        payload=api.call_args.args[1];sent=json.loads(payload['input'])
        self.assertEqual([v['count'] for v in sent['seller_variants']],[3,10])
        self.assertEqual(card['pack_counts'],[3,10]);self.assertEqual(card['skus'],['MY-3','DEMO-10'])
        self.assertNotIn('properties',payload['text']['format']['schema']['properties']['uz']['properties'])
        self.assertIn('Kabel bilan',card['uz']['full']);self.assertIn('С кабелем',card['ru']['composition'])
        for lang in ('uz','ru'):
            self.assertLessEqual(engine.utf16len(card[lang]['short']),390)
            self.assertNotIn('1 dona',card[lang]['full'])
            self.assertEqual(card[lang]['properties'],[])
            for key,block in card['variant_text_blocks'][lang].items():self.assertTrue(card[lang][key].endswith(block))

    def test_invalid_variants_never_call_model(self):
        with patch.object(engine,'openai_request') as api:
            with self.assertRaises(engine.Problem):engine.generate(SOURCE,'sk-offline-test-placeholder','sales','',False,engine.APP_MODEL,{},[{'count':0}])
            api.assert_not_called()

    def test_http_route_forwards_variants(self):
        handler=object.__new__(start.Handler);handler.path='/api/generate';handler.reply=lambda result:None
        body={'ticket':'qa','url':SOURCE['url'],'model':engine.APP_MODEL,'variants':[{'count':7}],'options':{'images':False}}
        with patch.object(start,'source_for_ticket',return_value=SOURCE),patch.object(engine,'generate',return_value={}) as generate:
            handler.process(body)
            self.assertEqual(generate.call_args.args[7],[{'count':7}])

if __name__=='__main__':unittest.main()
