import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { App } from './App';
import { getPlatform, type CaptureSnapshotResult, type SnapshotSummary, type SemanticBundle, type ObjectAnnotation } from './platform';
import type { SchemaCanvasProps } from './components/SchemaCanvas';
import { reportSnapshot, reportSemantics } from './test/schema-report-fixture';
import { discoverySettings } from './test/discovery-fixture';
const target = reportSnapshot.schemas[0].tables[1];
afterEach(() => vi.restoreAllMocks());
vi.mock('./components/ConnectionPanel',()=>({ConnectionPanel:({onSnapshot}:{onSnapshot:(r:CaptureSnapshotResult)=>void})=><><button onClick={()=>onSnapshot({snapshot:reportSnapshot,stored:true,changeSet:null})}>Load review source</button><button onClick={()=>onSnapshot({snapshot:{...reportSnapshot,id:"snapshot-b",sourceId:"source-b"},stored:true,changeSet:null})}>Load other source</button></>}));
vi.mock('./components/SchemaCanvas',()=>({SchemaCanvas:(props:SchemaCanvasProps)=><button onClick={()=>props.onSelectTable(target)}>Select review table</button>}));

it('refreshes committed confirmation after switching away from the editing segment', async()=>{
  localStorage.clear(); window.history.replaceState(null, '', '/'); const platform=getPlatform(); const key=target.key;
  let bundle: SemanticBundle={...reportSemantics,annotations:[{sourceId:reportSnapshot.sourceId,objectKey:key,description:'quasarzephyr',tags:[],owner:null,isCore:false,updatedAt:'old'}],knowledge:[{sourceId:reportSnapshot.sourceId,objectKey:key,status:'confirmed',reason:'Confirmed locally',confirmation:{id:'proof',sourceId:reportSnapshot.sourceId,objectKey:key,finalText:'quasarzephyr',descriptionDigest:'old-digest',snapshotId:reportSnapshot.id,fingerprint:reportSnapshot.fingerprint,confirmedAt:'old',basis:{tables:[[key,'table-hash']],relationships:[],notes:[]},origin:{kind:'manualReview',requestId:null,provider:null,model:null,generatedAt:null,evidence:{}}}}]};
  vi.spyOn(platform,'getRuntimeInfo').mockResolvedValue({kind:'desktop',label:'Review runtime',version:'test'});
  const settings=discoverySettings(); settings.source!.ai.includeConfirmedSemantics=true;
  vi.spyOn(platform,'getSettings').mockResolvedValue(settings);
  vi.spyOn(platform,'updateAppSettings').mockResolvedValue(settings);
  const reads=vi.spyOn(platform,'getSemantics').mockImplementation((sourceId)=>Promise.resolve(sourceId===reportSnapshot.sourceId?structuredClone(bundle):{annotations:[],orphanedAnnotations:[],domainGroups:[],savedViews:[],layout:null,logicalRelationships:[],ignoredRelationshipInferences:[],knowledge:[]}));
  vi.spyOn(platform,'listSnapshots').mockImplementation((source)=>Promise.resolve([{id:source==='source-b'?'snapshot-b':reportSnapshot.id} as SnapshotSummary]));
  vi.spyOn(platform,'prepareKnowledgeDraft').mockResolvedValue({id:'draft-a',sourceId:reportSnapshot.sourceId,snapshotId:reportSnapshot.id,target:key,oldDescription:'quasarzephyr',draftText:'Current confirmed note',expiresAt:new Date(Date.now()+300000).toISOString(),basis:{tables:[],relationships:[],notes:[]},origin:{kind:'manualReview',evidence:{},requestId:null,provider:null,model:null,generatedAt:null}});
  let finish!:()=>void;
  const confirm=vi.spyOn(platform,'confirmKnowledgeDraft').mockImplementation(()=>new Promise<ObjectAnnotation>(resolve=>{finish=()=>{
    bundle={...bundle,annotations:[{...bundle.annotations[0],description:'Current confirmed note',updatedAt:'new'}],knowledge:bundle.knowledge!.map(s=>({...s,confirmation:{...s.confirmation!,id:'proof-new',finalText:'Current confirmed note',descriptionDigest:'new-digest',confirmedAt:'new'}}))};resolve(bundle.annotations[0]);
  };}));
  vi.spyOn(platform,'cancelKnowledgeDraft').mockResolvedValue(undefined);
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><App/></QueryClientProvider>);
  await screen.findByText('Review runtime');fireEvent.click(screen.getByRole('button',{name:'Load review source'}));
  fireEvent.click(await screen.findByRole('button',{name:'Select review table'}));fireEvent.click(screen.getByRole('button',{name:'Semantics'}));
  await screen.findByDisplayValue('quasarzephyr');
  fireEvent.click(await screen.findByRole('button',{name:'Review and confirm description'}));
  await screen.findByLabelText('Proposed description');fireEvent.click(screen.getByRole('button',{name:'Confirm this description'}));
  await waitFor(()=>expect(confirm).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button',{name:'Table'}));
  await act(async()=>{finish();await Promise.resolve();});
  fireEvent.click(screen.getByRole('button',{name:'Semantics'}));
  expect.soft(screen.getByLabelText('Description')).toHaveValue('Current confirmed note');
  fireEvent.click(screen.getByRole('button',{name:'Business question'}));fireEvent.change(screen.getByRole('textbox', {name:'Business question'}),{target:{value:'quasarzephyr'}});fireEvent.click(screen.getByRole('button',{name:'Search locally'}));
  expect.soft(screen.queryByText('public.orders',{selector:'h4'})).toBeNull();
  expect(reads).toHaveBeenCalledTimes(2);
});

it.each(['annotation-return', 'confirmation-return', 'confirmation-other'] as const)('isolates committed writes while refreshing their source (%s)', async(entry)=>{
  localStorage.clear(); window.history.replaceState(null, '', '/'); const platform=getPlatform(); const key=target.key;
  let bundle: SemanticBundle={...reportSemantics,annotations:[{sourceId:reportSnapshot.sourceId,objectKey:key,description:'quasarzephyr',tags:[],owner:null,isCore:false,updatedAt:'old'}],knowledge:[{sourceId:reportSnapshot.sourceId,objectKey:key,status:'confirmed',reason:'Confirmed locally',confirmation:{id:'proof',sourceId:reportSnapshot.sourceId,objectKey:key,finalText:'quasarzephyr',descriptionDigest:'old-digest',snapshotId:reportSnapshot.id,fingerprint:reportSnapshot.fingerprint,confirmedAt:'old',basis:{tables:[[key,'table-hash']],relationships:[],notes:[]},origin:{kind:'manualReview',requestId:null,provider:null,model:null,generatedAt:null,evidence:{}}}}]};
  vi.spyOn(platform,'getRuntimeInfo').mockResolvedValue({kind:'desktop',label:'Review runtime',version:'test'});
  const settings=discoverySettings(); settings.source!.ai.includeConfirmedSemantics=true;
  vi.spyOn(platform,'getSettings').mockResolvedValue(settings);
  vi.spyOn(platform,'updateAppSettings').mockResolvedValue(settings);
  const reads=vi.spyOn(platform,'getSemantics').mockImplementation((sourceId)=>Promise.resolve(sourceId===reportSnapshot.sourceId?structuredClone(bundle):{annotations:[],orphanedAnnotations:[],domainGroups:[],savedViews:[],layout:null,logicalRelationships:[],ignoredRelationshipInferences:[],knowledge:[]}));
  vi.spyOn(platform,'listSnapshots').mockImplementation((source)=>Promise.resolve([{id:source==='source-b'?'snapshot-b':reportSnapshot.id} as SnapshotSummary]));
  vi.spyOn(platform,'prepareKnowledgeDraft').mockResolvedValue({id:'draft-a',sourceId:reportSnapshot.sourceId,snapshotId:reportSnapshot.id,target:key,oldDescription:'quasarzephyr',draftText:'Current confirmed note',expiresAt:new Date(Date.now()+300000).toISOString(),basis:{tables:[],relationships:[],notes:[]},origin:{kind:'manualReview',evidence:{},requestId:null,provider:null,model:null,generatedAt:null}});
  let finish!:()=>void;
  const save=vi.spyOn(platform,entry==='annotation-return'?'saveAnnotation':'confirmKnowledgeDraft').mockImplementation(()=>new Promise<ObjectAnnotation>(resolve=>{finish=()=>{
    bundle={...bundle,annotations:[{...bundle.annotations[0],description:'Current confirmed note',updatedAt:'new'}],knowledge:bundle.knowledge!.map(s=>entry==='annotation-return'?{...s,status:'pendingReview',reason:'Description changed'}:{...s,confirmation:{...s.confirmation!,id:'new-proof',finalText:'Current confirmed note',descriptionDigest:'new-digest',confirmedAt:'new'}})};resolve(bundle.annotations[0]);
  };}));
  vi.spyOn(platform,'cancelKnowledgeDraft').mockResolvedValue(undefined);
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><App/></QueryClientProvider>);
  await screen.findByText('Review runtime');fireEvent.click(screen.getByRole('button',{name:'Load review source'}));
  fireEvent.click(await screen.findByRole('button',{name:'Select review table'}));fireEvent.click(screen.getByRole('button',{name:'Semantics'}));
  await screen.findByDisplayValue('quasarzephyr');
  if (entry==='annotation-return') {
    fireEvent.change(screen.getByLabelText('Description'),{target:{value:'Current confirmed note'}});
    fireEvent.click(screen.getByRole('button',{name:'Save knowledge'}));
  } else {
    fireEvent.click(await screen.findByRole('button',{name:'Review and confirm description'}));
    await screen.findByLabelText('Proposed description');
    fireEvent.click(screen.getByRole('button',{name:'Confirm this description'}));
  }
  await waitFor(()=>expect(save).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button',{name:'Load other source'}));
  await waitFor(()=>expect(reads).toHaveBeenCalledTimes(2));
  if (entry==='confirmation-other') {
    fireEvent.click(screen.getByRole('button',{name:'Select review table'}));
    await waitFor(()=>expect(screen.getByLabelText('Description')).toHaveValue(''));
    await act(async()=>{finish();await Promise.resolve();});
    expect(screen.getByLabelText('Description')).toHaveValue('');
    expect(reads).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button',{name:'Load review source'}));
    await waitFor(()=>expect(reads).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole('button',{name:'Select review table'}));
    fireEvent.click(screen.getByRole('button',{name:'Semantics'}));
    await screen.findByDisplayValue('Current confirmed note');
    expect(reads).toHaveBeenCalledTimes(3);
    return;
  }
  fireEvent.click(screen.getByRole('button',{name:'Load review source'}));
  await waitFor(()=>expect(reads).toHaveBeenCalledTimes(3));
  fireEvent.click(screen.getByRole('button',{name:'Select review table'}));
  await screen.findByDisplayValue('quasarzephyr');
  await act(async()=>{finish();await Promise.resolve();});
  fireEvent.click(screen.getByRole('button',{name:'Semantics'}));
  expect.soft(screen.getByLabelText('Description')).toHaveValue('Current confirmed note');
  fireEvent.click(screen.getByRole('button',{name:'Business question'}));fireEvent.change(screen.getByRole('textbox', {name:'Business question'}),{target:{value:'quasarzephyr'}});fireEvent.click(screen.getByRole('button',{name:'Search locally'}));
  expect.soft(screen.queryByText('public.orders',{selector:'h4'})).toBeNull();
  expect(reads).toHaveBeenCalledTimes(4);
});
