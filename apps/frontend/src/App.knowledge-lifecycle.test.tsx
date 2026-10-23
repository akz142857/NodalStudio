import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { App } from './App';
import { getPlatform, type CaptureSnapshotResult, type SnapshotSummary, type SemanticBundle } from './platform';
import type { SchemaCanvasProps } from './components/SchemaCanvas';
import { reportSnapshot } from './test/schema-report-fixture';
import { tableAiSettings, tableAiPreview, tableAiResult } from './test/table-ai-fixture';
const snapshotA = {...reportSnapshot, id:'snapshot-a',sourceId:'source-a'};
const snapshotB = {...reportSnapshot, id:'snapshot-b',sourceId:'source-b',database:{...reportSnapshot.database,name:'Source B database'}};
function bundle(sourceId:string,text:string):SemanticBundle {return {annotations:[{sourceId,objectKey:reportSnapshot.schemas[0].tables[1].key,description:text,tags:[],owner:null,isCore:false,updatedAt:text}], orphanedAnnotations:[],domainGroups:[],savedViews:[],layout:null,ignoredRelationshipInferences:[],logicalRelationships:[],knowledge:[]};}
vi.mock('./components/ConnectionPanel',()=>({ConnectionPanel:({onSnapshot}:{onSnapshot:(r:CaptureSnapshotResult)=>void})=><><button onClick={()=>onSnapshot({snapshot:snapshotA,stored:true,changeSet:null})}>Load source A</button><button onClick={()=>onSnapshot({snapshot:snapshotB,stored:true,changeSet:null})}>Load source B</button></>}));
vi.mock('./components/SchemaCanvas',()=>({SchemaCanvas:(props:SchemaCanvasProps)=><button onClick={()=>props.onSelectTable(props.snapshot.schemas[0].tables[1])}>Select current table</button>}));
beforeEach(()=>localStorage.clear());afterEach(()=>vi.restoreAllMocks());
it.each(['manual', 'model', 'return-to-a', 'reload-order'] as const)('isolates late confirmation refresh (%s) across source sessions', async(entry)=>{
 const platform=getPlatform(); let aCalls=0; let resolveOld!:(v:SemanticBundle)=>void;
 vi.spyOn(platform,'getRuntimeInfo').mockResolvedValue({kind:'desktop',label:'Review runtime',version:'test'});
 vi.spyOn(platform,'getSettings').mockImplementation((source)=>{const settings=tableAiSettings();settings.source!.sourceId=source??'source-a';return Promise.resolve(settings);});
 const semantics=vi.spyOn(platform,'getSemantics').mockImplementation(async(source)=>{if(source==='source-a'&&++aCalls===2)return new Promise(r=>{resolveOld=r;});return bundle(source, source==='source-b'?'Source B original note':entry==='reload-order'&&aCalls>2?'Source A newer note':'Source A original note');});
 vi.spyOn(platform,'listSnapshots').mockImplementation((source)=>Promise.resolve([{id:source==='source-b'?'snapshot-b':'snapshot-a'} as SnapshotSummary]));
 vi.spyOn(platform,'prepareKnowledgeDraft').mockResolvedValue({id:'draft-a',sourceId:'source-a',snapshotId:'snapshot-a',target:reportSnapshot.schemas[0].tables[1].key,oldDescription:'Source A original note',draftText:'Source A confirmed note',expiresAt:new Date(Date.now()+300000).toISOString(),basis:{tables:[],relationships:[],notes:[]},origin:{kind:'manualReview',evidence:{},requestId:null,provider:null,model:null,generatedAt:null}});
 vi.spyOn(platform,'prepareTableExplanation').mockResolvedValue({...tableAiPreview,sourceId:'source-a',snapshotId:'snapshot-a',expiresAt:new Date(Date.now()+300000).toISOString()});
 vi.spyOn(platform,'runTableExplanation').mockResolvedValue({...tableAiResult,sourceId:'source-a',snapshotId:'snapshot-a'});
 vi.spyOn(platform,'cancelTableExplanation').mockResolvedValue(undefined);
 vi.spyOn(platform,'saveAnnotation').mockResolvedValue({} as never);
 vi.spyOn(platform,'confirmKnowledgeDraft').mockResolvedValue({} as never);vi.spyOn(platform,'cancelKnowledgeDraft').mockResolvedValue(undefined);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><App/></QueryClientProvider>);
 await screen.findByText('Review runtime');fireEvent.click(screen.getByRole('button',{name:'Load source A'}));
 await waitFor(()=>expect(semantics).toHaveBeenCalledWith('source-a'));fireEvent.click(await screen.findByRole('button',{name:'Select current table'}));if(entry==='model') {
   fireEvent.click(screen.getByRole('button',{name:'AI'}));
   await waitFor(()=>expect(screen.getByRole('button',{name:'Send and answer'})).toBeEnabled());
   fireEvent.click(await screen.findByRole('button',{name:'Send and answer'}));
   fireEvent.click(await screen.findByRole('button',{name:'Draft a table description'}));
 } else {
   fireEvent.click(screen.getByRole('button',{name:'Semantics'}));
   fireEvent.click(await screen.findByRole('button',{name:'Review and confirm description'}));
 }
 await screen.findByLabelText('Proposed description');fireEvent.click(screen.getByRole('button',{name:'Confirm this description'}));await waitFor(()=>expect(aCalls).toBe(2));
 if(entry==='reload-order') {
   fireEvent.change(screen.getByLabelText('Description'),{target:{value:'Source A newer note'}});
   fireEvent.click(screen.getByRole('button',{name:'Save knowledge'}));
   await waitFor(()=>expect(aCalls).toBe(3));
   await screen.findByDisplayValue('Source A newer note');
 } else {
 fireEvent.click(screen.getByRole('button',{name:'Load source B'}));await waitFor(()=>expect(semantics).toHaveBeenCalledWith('source-b'));fireEvent.click(screen.getByRole('button',{name:'Select current table'}));
 fireEvent.click(screen.getByRole('button',{name:'Semantics'}));
 await screen.findByDisplayValue('Source B original note');
 if(entry==='return-to-a') {
   fireEvent.click(screen.getByRole('button',{name:'Load source A'}));
   await waitFor(()=>expect(aCalls).toBe(3));
   fireEvent.click(screen.getByRole('button',{name:'Select current table'}));
   await screen.findByDisplayValue('Source A original note');
 }

 }

 await act(async()=>{resolveOld(bundle('source-a','Source A late confirmed note'));await Promise.resolve();});
 expect(screen.getByLabelText('Description')).toHaveValue(entry==='reload-order'?'Source A newer note':entry==='return-to-a'?'Source A original note':'Source B original note');
});
