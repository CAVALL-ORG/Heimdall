import { KetcherRuntime } from '../../../server/src/mcp/runtime';
import { writeFileSync } from 'node:fs';

async function main() {
  const runtime = new KetcherRuntime();
  try {
    await runtime.start({ mode: 'standalone' });
    await runtime.callBridge('clearCanvas');
    
    // Add pyridine ring: atoms 0:C,1:C,2:C,3:N,4:C,5:C  ring: 0-1-2-3-4-5-0
    await runtime.callBridge('addFragment', 'c1ccncc1');
    
    // Set atom 1 to N → pyrimidine (N at 1,3)
    // Mapping: 1=N1, 2=C2, 3=N3, 4=C4, 5=C5, 0=C6
    await runtime.callBridge('setAtomElement', 1, 'N');
    
    // Build fused imidazole 5-ring on C5(5)-C4(4)
    await runtime.callBridge('addAtomWithSingleBond', 5, 'N');  // 6=N7
    await runtime.callBridge('addAtomWithSingleBond', 6, 'C');  // 7=C8
    await runtime.callBridge('addAtomWithSingleBond', 7, 'N');  // 8=N9
    await runtime.callBridge('addBond', 8, 4, 1);               // close 5-ring: N9-C4
    
    // Add carbonyls: C2(2)=O and C6(0)=O
    await runtime.callBridge('addAtomWithSingleBond', 2, 'O', 2);  // 9=O on C2
    await runtime.callBridge('addAtomWithSingleBond', 0, 'O', 2);  // 10=O on C6
    
    // Add methyls: N1(1)-CH3, N3(3)-CH3, N7(6)-CH3
    await runtime.callBridge('addAtomWithSingleBond', 1, 'C');  // 11=CH3 on N1
    await runtime.callBridge('addAtomWithSingleBond', 3, 'C');  // 12=CH3 on N3
    await runtime.callBridge('addAtomWithSingleBond', 6, 'C');  // 13=CH3 on N7
    
    // Set C8=N9 double bond in the 5-ring
    let state: any = await runtime.getState();
    const c8n9bond = state.bonds.find((b: any) => 
      (b.beginAtomId === 7 && b.endAtomId === 8) || (b.beginAtomId === 8 && b.endAtomId === 7)
    );
    if (c8n9bond) {
      await runtime.callBridge('setBondOrder', c8n9bond.id, 2);
    }
    
    // Layout
    await runtime.callBridge('layout');
    
    // Check heavy atom count
    state = await runtime.getState();
    console.log('Heavy atoms:', state.atoms.length, '(expect 14)');
    console.log(state.atoms.map((a: any) => `${a.id}:${a.label}`).join(', '));
    
    // Render (bridge returns base64 string)
    const base64: string = await runtime.callBridge('renderCanvas', { showAtomIds: false });
    const pngBuf = Buffer.from(base64, 'base64');
    writeFileSync('/tmp/caffeine_render.png', pngBuf);
    console.log('Render saved to /tmp/caffeine_render.png');
    
    // Export SMILES
    const smiles = await runtime.exportSmiles();
    console.log('SMILES:', smiles);
    
  } finally {
    await runtime.stop();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
