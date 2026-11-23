"""Offline checks for image prompt transport, count and safe visual controls."""
import copy
import json
import unittest
from html.parser import HTMLParser
from types import SimpleNamespace
from unittest.mock import patch
from test_variants import SOURCE,ANSWER
import engine
import image_design
import start

class PageScripts(HTMLParser):
    def __init__(self):
        super().__init__();self.scripts={};self.current=None
    def handle_starttag(self,tag,attrs):
        if tag=='script':
            self.current=dict(attrs).get('id')
            if self.current:self.scripts[self.current]=''
    def handle_data(self,data):
        if self.current:self.scripts[self.current]+=data
    def handle_endtag(self,tag):
        if tag=='script':self.current=None

def response(answer):
    return {"output":[{"type":"message","content":[{"type":"output_text","text":json.dumps(answer,ensure_ascii=False)}]}]}

class ImageDesignTests(unittest.TestCase):
    def test_invalid_settings(self):
        for value in ({'count':0},{'count':11},{'count':1.5},{'count':True},{'count':'4'},{'prompt':'a'*2001},{'prompt':{}},{'mode':'script'}):
            with self.subTest(value=value),self.assertRaises(ValueError):image_design.settings(value)

    def test_image_prompt_and_count_reach_model(self):
        answer=copy.deepcopy(ANSWER);answer['image_design']=image_design.defaults(4)
        for p in answer['image_design']['plans']:p.update(background='#112233',accent='#33bbff',layout='split_left',text_mode='minimal',photo_scale=1)
        answer['image_design']['note']='To‘q ko‘k fon, chapda katta mahsulot va ixcham matn.'
        image_settings={'count':4,'prompt':'To‘q ko‘k fon, mahsulot chapda, minimal matn.'}
        with patch.object(engine,'openai_request',return_value=response(answer)) as api:
            card=engine.generate(SOURCE,'sk-offline-test-placeholder','sales','',False,engine.APP_MODEL,{'images':True},None,image_settings)
        payload=api.call_args.args[1];sent=json.loads(payload['input'])
        self.assertEqual(sent['image_settings']['prompt'],image_settings['prompt'])
        self.assertEqual(sent['image_settings']['count'],4)
        self.assertEqual(payload['text']['format']['schema']['properties']['image_design']['properties']['plans']['minItems'],4)
        self.assertEqual(len(card['image_design']['plans']),4)
        self.assertEqual(card['image_design']['plans'][0]['background'],'#112233')
        self.assertNotIn(image_settings['prompt'],card['uz']['full'])

    def test_disabled_images_do_not_send_prompt(self):
        with patch.object(engine,'openai_request',return_value=response(ANSWER)) as api:
            card=engine.generate(SOURCE,'sk-offline-test-placeholder','sales','',False,engine.APP_MODEL,{'images':False},None,{'count':7,'prompt':'My image-only prompt'})
        payload=api.call_args.args[1]
        self.assertNotIn('My image-only prompt',payload['input'])
        self.assertNotIn('image_design',payload['text']['format']['schema']['properties'])
        self.assertEqual(card['image_settings']['prompt'],'')

    def test_default_counts_and_distinct_compositions(self):
        for count in (1,3,6,10):
            plans=image_design.normalize(image_design.defaults(count),count)['plans']
            self.assertEqual(len(plans),count)
            self.assertEqual(len({json.dumps(p,sort_keys=True) for p in plans}),count)

    def test_bad_design_and_count_rejected(self):
        for mutation in ('count','color','layout','scale','note'):
            design=image_design.defaults(2)
            if mutation=='count':design['plans'].pop()
            elif mutation=='color':design['plans'][0]['background']='url(https://example.com)'
            elif mutation=='layout':design['plans'][0]['layout']='<script>'
            elif mutation=='scale':design['plans'][0]['photo_scale']=float('nan')
            else:design['note']={}
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):image_design.normalize(design,2)

    def test_image_settings_route(self):
        handler=object.__new__(start.Handler);handler.path='/api/generate';handler.reply=lambda result:None
        selected={'count':6,'prompt':'Oq fon, katta mahsulot','mode':'product'}
        body={'ticket':'qa','url':SOURCE['url'],'model':engine.APP_MODEL,'image_settings':selected,'options':{'images':True}}
        with patch.object(start,'source_for_ticket',return_value=SOURCE),patch.object(engine,'generate',return_value={}) as generate:
            handler.process(body)
            self.assertEqual(generate.call_args.args[8],selected)

    def test_pages_and_logo_assets(self):
        handler=object.__new__(start.Handler);handler.server=SimpleNamespace(server_address=('127.0.0.1',8000));handler.headers={'Host':'127.0.0.1:8000'}
        captured=[];handler.send_data=lambda *args:captured.append(args)
        for path in ('/','/other','/demo.html'):
            handler.path=path;handler.do_GET();status,raw,mime=captured[-1]
            self.assertEqual(status,200);self.assertIn('text/html',mime)
            page=PageScripts();page.feed(raw.decode())
            self.assertTrue(json.loads(page.scripts['card-brand']).startswith('data:image/png;base64,'))
            self.assertIn('window.ImageTools',page.scripts['card-runtime'])
            if path!='/demo.html':
                config=json.loads(page.scripts['studio-config'])
                self.assertEqual(config['source_mode'],'external' if path=='/other' else 'uzum')
            else:self.assertEqual(json.loads(page.scripts['saved-card'])['image_settings']['count'],3)
        for extension,mime in (('png','image/png'),('mp4','video/mp4')):
            handler.path='/assets/brand-logo.'+extension;handler.do_GET()
            self.assertEqual(captured[-1][0],200);self.assertEqual(captured[-1][2],mime);self.assertGreater(len(captured[-1][1]),1000)

if __name__=='__main__':unittest.main()
