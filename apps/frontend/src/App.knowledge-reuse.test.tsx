import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { App } from './App';
import { getPlatform, type CaptureSnapshotResult, type SnapshotSummary, type SemanticBundle, type SaveLogicalRelationshipInput, type LogicalRelationship, type DomainGroup } from './platform';
import type { SchemaCanvasProps } from './components/SchemaCanvas';
import { reportSnapshot, reportSemantics } from './test/schema-report-fixture';
import { discoverySettings } from './test/discovery-fixture';
const target = reportSnapshot.schemas[0].tables[1];
const relation: SaveLogicalRelationshipInput = { id: 'relation', sourceId: reportSnapshot.sourceId, name: 'customer', source: {schema: 'public', table: 'orders', columns: ['customer_id']}, target: {schema: 'public', table: 'customers', columns: ['id']}, cardinality: 'manyToOne' };
afterEach(() => vi.restoreAllMocks());
vi.mock('./components/ConnectionPanel',()=>({ConnectionPanel:({onSnapshot}:{onSnapshot:(r:CaptureSnapshotResult)=>void})=><button onClick={()=>onSnapshot({snapshot:reportSnapshot,stored:true,changeSet:null})}>Load review source</button>}));
vi.mock('./components/SchemaCanvas',()=>({SchemaCanvas:(props:SchemaCanvasProps)=><><button onClick={()=>props.onSelectTable(target)}>Select review table</button>
<button onClick={()=>void props.onCreateLogicalRelationship?.(relation)}>Create relationship</button>
<button onClick={()=>void props.onUpdateLogicalRelationship?.(relation)}>Update relationship</button>
<button onClick={()=>void props.onDeleteLogicalRelationship?.('relation')}>Delete relationship</button></>}));
it.each(['manual', 'domain-race', 'create', 'update', 'delete', 'delete-missing', 'git', 'git-settings-error', 'cloud', 'portable', 'history', 'semantics'] as const)('stops confirmed-note recall after %s mutation', async(kind)=>{
  localStorage.clear(); window.history.replaceState(null, '', '/'); const platform=getPlatform(); const key=target.key;
  let bundle: SemanticBundle={...reportSemantics,annotations:[{sourceId:reportSnapshot.sourceId,objectKey:key,description:'quasarzephyr',tags:[],owner:null,isCore:false,updatedAt:'old'}],knowledge:[{sourceId:reportSnapshot.sourceId,objectKey:key,status:'confirmed',reason:'Confirmed locally',confirmation:{id:'proof',sourceId:reportSnapshot.sourceId,objectKey:key,finalText:'quasarzephyr',descriptionDigest:'old-digest',snapshotId:reportSnapshot.id,fingerprint:reportSnapshot.fingerprint,confirmedAt:'old',basis:{tables:[[key,'table-hash']],relationships:[],notes:[]},origin:{kind:'manualReview',requestId:null,provider:null,model:null,generatedAt:null,evidence:{}}}}]};
  vi.spyOn(platform,'getRuntimeInfo').mockResolvedValue({kind:'desktop',label:'Reuse review',version:'test'});
  const settings=discoverySettings(); settings.source!.ai.includeConfirmedSemantics=true; settings.source!.git.repositoryPath='/synthetic'; settings.source!.cloud.enabled=true; settings.app.privacy.offlineMode=false;
  vi.spyOn(platform,'updateAppSettings').mockResolvedValue(settings);
  let mutated=false;
  vi.spyOn(platform,'getSettings').mockImplementation(()=>kind==='git-settings-error'&&mutated?Promise.reject(new Error('Settings unavailable')):Promise.resolve(settings));
  const semantics=vi.spyOn(platform,'getSemantics').mockImplementation(()=>Promise.resolve(structuredClone(bundle)));
  const invalidate = () => { mutated=true; bundle={...bundle,knowledge:bundle.knowledge!.map(s=>({...s,status:'pendingReview',reason:'Supporting evidence changed'}))}; };
  vi.spyOn(window,'confirm').mockReturnValue(true);
  vi.spyOn(platform,'listDataSources').mockResolvedValue([{id:reportSnapshot.sourceId,displayName:'Review source',host:'fixture',port:5432,database:'fixture',username:'reader',databaseType:'postgreSql',sslMode:'prefer',createdAt:'old',updatedAt:'old'}]);
  vi.spyOn(platform,'previewSourceDataDeletion').mockResolvedValue({snapshotRecords:1,semanticRecords:1} as never);
  vi.spyOn(platform,'deleteSourceData').mockImplementation(()=>{invalidate();return Promise.resolve(1);});
  vi.spyOn(platform,'previewGitImport').mockResolvedValue({relationshipConflicts:[]} as never);
  vi.spyOn(platform,'importGitWorkspace').mockImplementation(()=>{invalidate();return Promise.resolve({} as never);});
  vi.spyOn(platform,'previewPortableBackup').mockResolvedValue({sourceId:reportSnapshot.sourceId,exportedAt:new Date().toISOString()} as never);
  vi.spyOn(platform,'importPortableBackup').mockImplementation(()=>{invalidate();return Promise.resolve({} as never);});
  vi.spyOn(platform,'syncProject').mockImplementation(()=>{invalidate();return Promise.resolve({} as never);});
  vi.spyOn(platform,'listSyncDiagnostics').mockResolvedValue([]);
  for(const method of ['createLogicalRelationship','updateLogicalRelationship'] as const) vi.spyOn(platform,method).mockImplementation(()=>{invalidate();return Promise.resolve({...relation,status:'active',origin:'manual',evidence:[],note:null,createdAt:'old',updatedAt:'new'} as LogicalRelationship);});
  vi.spyOn(platform,'deleteLogicalRelationship').mockImplementation(()=>{invalidate();return Promise.resolve(kind!=='delete-missing');});
  vi.spyOn(platform,'listSnapshots').mockResolvedValue([{id:reportSnapshot.id} as SnapshotSummary]);
  let finishGroup!: (group: DomainGroup) => void;
  vi.spyOn(platform,'saveDomainGroup').mockImplementation(()=>new Promise(resolve=>{finishGroup=resolve;}));
  const save=vi.spyOn(platform,'saveAnnotation').mockImplementation((input)=>{
    const saved={...input,updatedAt:'new'};
    bundle={...bundle,annotations:[saved],knowledge:bundle.knowledge!.map(s=>({...s,status:'pendingReview',reason:'Description changed'}))};
    return Promise.resolve(saved);
  });
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><App/></QueryClientProvider>);
  await screen.findByText('Reuse review');fireEvent.click(screen.getByRole('button',{name:'Load review source'}));
  fireEvent.click(await screen.findByRole('button',{name:'Select review table'}));fireEvent.click(screen.getByRole('button',{name:'Semantics'}));
  await screen.findByDisplayValue('quasarzephyr');
  if(kind==='domain-race') {
    fireEvent.change(screen.getByPlaceholderText('Business group'),{target:{value:'Late group'}});
    fireEvent.click(screen.getByRole('button',{name:'Add group'}));
    await waitFor(()=>expect(finishGroup).toBeDefined());
  }
  if(kind==='manual'||kind==='domain-race') {
    fireEvent.change(screen.getByLabelText('Description'),{target:{value:'Changed unreviewed description'}});fireEvent.click(screen.getByRole('button',{name:'Save knowledge'}));
    await waitFor(()=>expect(save).toHaveBeenCalledOnce());await screen.findByDisplayValue('Changed unreviewed description');
  } else if(['create','update','delete','delete-missing'].includes(kind)) {
    fireEvent.click(screen.getByRole('button',{name: `${kind==='delete-missing'?'Delete':kind[0].toUpperCase()+kind.slice(1)} relationship`}));
  } else {
    fireEvent.click(screen.getByRole('button',{name:'Open Settings'}));
    const category=kind.startsWith('git')?'Git':kind==='cloud'?'Cloud Sync':kind==='portable'?'History & Storage':'Data Sources';
    fireEvent.click(await screen.findByRole('button',{name:category}));
    if(kind==='portable') fireEvent.change(screen.getByLabelText('Portable backup path'),{target:{value:'/synthetic/model.nodalmodel'}});
    const action=kind==='cloud'?'Publish now':kind==='history'?'Delete history…':kind==='semantics'?'Delete semantics…':'Preview & import…';
    fireEvent.click(screen.getByRole('button',{name:action}));
    await waitFor(()=>expect(semantics).toHaveBeenCalledTimes(2));
    if(kind==='git-settings-error') await screen.findByText('Settings unavailable');
    fireEvent.click(screen.getByRole('button',{name:'← Back'}));
  }
  await waitFor(()=>expect(semantics).toHaveBeenCalledTimes(2));
  await waitFor(()=>expect(screen.getByText('Needs review')).toBeVisible());
  if(kind==='domain-race') await act(async()=>{finishGroup({id:'late-group',sourceId:reportSnapshot.sourceId,name:'Late group',description:null,color:'#123456',tableKeys:[key],updatedAt:'new'});await Promise.resolve();});
  fireEvent.click(screen.getByRole('button',{name:'Business question'}));fireEvent.change(screen.getByLabelText('Business question'),{target:{value:'quasarzephyr'}});fireEvent.click(screen.getByRole('button',{name:'Search locally'}));
  expect(screen.queryByText('public.orders',{selector:'h4'})).toBeNull();
});
