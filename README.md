# amfeix-glass
Includes JavaScript libraries to interact with AMFEIX contract and gather other details from on-chain.
Results are live on https://amfeix-glassdoor.info/

See config.example.js for external dependencies needed, create config.js with filled setup.

Execute with node index.js.

Setup index folders. These are used to keep state across multiple runs:
```
mkdir -p index/{accounts,contract,contract_rtx,contract_tx,tx}
mkdir -p index/accounts/{0,1,2,3,4,5,6,7,8,9,a,b,c,d,e,f}
mkdir -p index/contract_rtx/{0,1,2,3,4,5,6,7,8,9,a,b,c,d,e,f}
mkdir -p index/contract_tx/{0,1,2,3,4,5,6,7,8,9,a,b,c,d,e,f}
mkdir -p index/tx/{0,1,2,3,4,5,6,7,8,9,a,b,c,d,e,f}
mkdir -p index/contract/{d,f,k}
```
