'use strict';

import Web3 from "web3";
import bitcoin from "bitcoinjs-lib";
import ethereum_wallet from "ethereumjs-wallet";


export default class InvestorAccount{

     static async fromEthereumAddress(address, contract) {
         return new Promise((async (resolve, reject) => {
             let txCount = await contract.getTxCount(address);
             let account = null;
             for(let i = 0; i < txCount; ++i){
                 try{
                     let tx = await contract.getTx(address, i);
                     account = new InvestorAccount(tx.pubkey, contract)
                     break;
                 }catch (e) {
                     console.log("Account " + address + ": " + e)
                 }
             }
             if(account){
                 resolve(account)
             }else {
                 reject(new Error("Could not find valid transactions for account " + address))
             }

         }));
    }

    constructor(pubkey, contract) {
        this.pubkey = pubkey;
        let bpub = Buffer.from(pubkey, "hex");
        this.eth_address = ethereum_wallet.fromPublicKey(bpub, true).getChecksumAddressString();
        this.btc_address = bitcoin.payments.p2pkh({
            pubkey: bpub,
        }).address;
        this.contract = contract;
    }

    getEthereumAddress(){
        return this.eth_address;
    }

    getBitcoinAddress(){
        return this.btc_address;
    }

    getPublicKey(){
        return this.pubkey;
    }

    async getTransactions(){
        return new Promise((async (resolve, reject) => {
            let values = await this.contract.getTxs(this.eth_address);
            let txs = {};
            for(let i in values){
                let v = values[i];
                if(v.action === 0){
                    if(txs.hasOwnProperty(v.txid)){
                        if(!txs[v.txid].hasOwnProperty("dupe")){
                            txs[v.txid].dupe = [];
                        }
                        txs[v.txid].dupe.push(v);
                    }else{
                        txs[v.txid] = v;
                        txs[v.txid].exit_timestamp = null;
                    }
                }else if (v.action === 1){
                    txs[v.txid].exit_timestamp = v.time;
                }

            }

            let requests = await this.contract.getWithdrawRequests(this.eth_address);
            for(let j in requests){
                let rtx = requests[j];
                if(txs.hasOwnProperty(rtx.txid)){
                    if(txs[rtx.txid].hasOwnProperty("requested_exit") || rtx.pubkey !== txs[rtx.txid].pubkey/* || rtx.signature !== txs[rtx.txid].signature*/){
                        if(!txs[rtx.txid].hasOwnProperty("invalid_rtx")){
                            txs[rtx.txid].invalid_rtx = [];
                        }
                        txs[rtx.txid].invalid_rtx.push(rtx);
                    }else{
                        txs[rtx.txid].requested_exit = rtx.time;
                        txs[rtx.txid].rtx = rtx;
                    }
                }else{
                    console.log("WARNING: found unmatched rtx for " + this.eth_address);
                    console.log(rtx);
                }
            }

            resolve(txs);
        }));
    }

    async getTransactionsWithInterest(index){
        return new Promise((async (resolve, reject) => {
            let txs = await this.getTransactions();
            for(let txid in txs){
                let tx = txs[txid];
                let compoundedValue = 1;
                tx.last_interest = null;
                tx.fee = 0;

                for(let i = 0; i < index.length; ++i){
                    let entry = index[i];

                    if(tx.exit_timestamp !== null && entry.time > tx.exit_timestamp){
                        break;
                    }

                    if(entry.time < tx.time){
                        continue;
                    }

                    tx.last_interest = entry.time;

                    let newValue = compoundedValue * (1 + (entry.value / 100));
                    //Interest value includes 20% performance fee
                    if(entry.value > 0){
                        //TODO: make fee and performance value fetch from contract
                        tx.fee += ((newValue - compoundedValue) / 0.8) * 0.2;
                    }
                    compoundedValue = newValue;
                }

                tx.interest = compoundedValue;

                if(tx.signature === "referer"){
                    tx.fee = 0;
                }
            }

            resolve(txs);
        }))
    }

    async getBalance(){
        return new Promise(async (resolve, reject) => {
            if(this.contract.getBitcoin() === null){
                reject("this.contract.getBitcoin() === null");
                return;
            }

            let depositAddresses = await this.contract.getDepositAddresses();
            let index = await this.contract.getFundPerformance();
            let fee2 = await this.contract.getFee2();
            let transactions = await this.getTransactionsWithInterest(index);
            let currentValue = 0;
            let currentCompounded = 0;
            let currentFees = 0;
            let totalValue = 0;
            let totalCompounded = 0;
            let totalFees = 0;
            let firstInvestment = null;
            let lastInvestment = [null, 0];

            for(let txid in transactions){
                let tx = transactions[txid];
                let txdata = null;
                try{
                    txdata = await this.contract.getBitcoin().getTransaction(tx.txid);
                }catch (e) {
                    console.log(e)
                    console.trace()
                    delete transactions[txid];
                    continue;
                }

                for(var n = 0; n < txdata.vout.length; ++n){
                    let o = txdata.vout[n];
                    if(depositAddresses.includes(o.scriptPubKey.addresses[0])){
                        tx.value = o.value;
                    }
                }

                if(!tx.hasOwnProperty("value")){
                    reject("Could not find transaction value for txid " + tx.txid);
                    return;
                }

                if(tx.time < firstInvestment || firstInvestment === null){
                    firstInvestment = tx.time;
                }

                if((lastInvestment[0] === null || lastInvestment[1] !== 0) && tx.exit_timestamp !== null && tx.exit_timestamp > lastInvestment[1]){
                    lastInvestment = [tx, tx.exit_timestamp];
                }else if(tx.exit_timestamp === null && (lastInvestment[0] === null || lastInvestment[0].time < tx.time)){
                    lastInvestment = [tx, 0];
                }

                if(tx.signature === "referer"){
                    let compoundedValue = (tx.interest * tx.value - tx.value) * (fee2 / 10);
                    if(compoundedValue.toString()[0] === "-"){
                        //TODO: AMFEIX BUG If overall result is negative, value is positive instead???
                        compoundedValue *= -1;
                    }

                    totalCompounded += compoundedValue;
                    tx.balance = compoundedValue;
                    if(tx.exit_timestamp === null){
                        currentCompounded += compoundedValue;
                    }
                    tx.referral_value = tx.value;
                    tx.value = 0;
                }else{
                    let compoundedValue = tx.interest * tx.value;

                    totalCompounded += compoundedValue;
                    totalValue += tx.value;
                    totalFees += tx.fee * (compoundedValue - tx.value);
                    tx.balance = compoundedValue;

                    if(tx.exit_timestamp === null){
                        currentCompounded += compoundedValue;
                        currentValue += tx.value;
                        currentFees += tx.fee * (compoundedValue - tx.value);
                    }
                }

            }

            let relatedIndex = [];
            for(let i = 0; i < index.length; ++i){
                let entry = index[i];
                if(entry.time < firstInvestment){
                    continue;
                }

                if(lastInvestment[1] !== 0 && entry.time > lastInvestment[1]){
                    break;
                }

                relatedIndex.push(entry);
            }

            resolve({
                current: {
                    initial: currentValue,
                    balance: currentCompounded,
                    growth: currentCompounded - currentValue,
                    yield: currentValue === 0 ? 0 : (currentCompounded - currentValue) / currentValue,
                    fee: currentFees
                },
                total: {
                    initial: totalValue,
                    balance: totalCompounded,
                    growth: totalCompounded - totalValue,
                    yield: totalValue === 0 ? 0 : (totalCompounded - totalValue) / totalValue,
                    fee: totalFees
                },
                transactions: transactions,
                index: relatedIndex
            });

        });

    }




    async getEthereumBalance(){
        return new Promise((async (resolve, reject) => {
            let val = await this.contract.getProvider().eth.getBalance(this.eth_address, "latest");
            resolve(val / 1000000000000000000)
        }))
    }

    async getBitcoinMatchingTransactions(balance){
         return new Promise(async (resolve, reject) => {
             try{
                 let transactions = balance.transactions;
                 let txs = await this.contract.getBitcoin().getAddressTransactions(this.btc_address);
                 let matchingTransactions = [];
                 for(let i in txs){
                     let tx = txs[i];

                     tx.track_txid = [];

                     for(let j in transactions){
                         let btx = transactions[j];
                         if(tx.txid === btx.txid){
                             tx.track_type = "deposit";
                             tx.track_txid = [btx.txid];
                             break;
                         }
                     }



                     if(!tx.hasOwnProperty("track_type")){
                         let values = [];
                         for(let j in tx.vout){
                             let v = tx.vout[j];
                             if(v.scriptPubKey.addresses[0] === this.btc_address){
                                 values.push(v.value);
                             }
                         }


                         for(let j in transactions){
                             let btx = transactions[j];
                             if(btx.exit_timestamp !== null){
                                 let timeDiff = Math.abs(btx.exit_timestamp - tx.time);

                                 if(timeDiff < 3600){
                                     for(let k in values){
                                         let v = values[k];
                                         let valueDiff = Math.abs(btx.balance - v);
                                         if(valueDiff < 0.000001){
                                             //Precise match
                                             tx.track_type = "withdrawal";
                                             tx.track_txid.push(btx.txid);
                                             break;
                                         }
                                     }

                                     if(!tx.track_txid.includes(btx.txid)){
                                         let delta = 0.005;
                                         for(let k in values){
                                             let v = values[k];
                                             let valueDiff = Math.abs(btx.balance - v);
                                             if(valueDiff < (btx.balance * delta)){
                                                 //Non-precise match
                                                 tx.track_type = "withdrawal";
                                                 tx.track_txid.push(btx.txid);
                                                 break;
                                             }
                                         }
                                     }
                                 }
                             }
                         }

                         if(!tx.hasOwnProperty("track_type")){
                             for(let j in transactions){
                                 let btx = transactions[j];
                                 if(btx.exit_timestamp !== null){
                                     let timeDiff = Math.abs(btx.exit_timestamp - tx.time);

                                     if(timeDiff < (3600 * 24)){
                                         let delta = 0.05;
                                         for(let k in values){
                                             let v = values[k];
                                             let valueDiff = Math.abs(btx.balance - v);
                                             if(valueDiff < (btx.balance * delta)){
                                                 //VERY Non-precise match
                                                 tx.track_type = "withdrawal";
                                                 tx.track_txid.push(btx.txid);
                                                 break;
                                             }
                                         }

                                         if(!tx.track_txid.includes(btx.txid)){
                                             for(let k in values){
                                                 let v = values[k];
                                                 let valueDiff = Math.abs(btx.balance - v);
                                                 if(valueDiff < 0.0008){
                                                     //Precise match
                                                     tx.track_type = "withdrawal";
                                                     tx.track_txid.push(btx.txid);
                                                     break;
                                                 }
                                             }
                                         }
                                     }
                                 }
                             }
                         }
                     }

                     if(tx.hasOwnProperty("track_type")){
                         matchingTransactions.push(tx);
                     }
                 }

                 resolve(matchingTransactions)
             }catch (e) {
                 console.log(e)
                 resolve([])
             }

         });

    }

    async getBitcoinUnspentTransactionsData(){
        return new Promise((async (resolve, reject) => {
            if(this.contract.getBitcoin() === null){
                reject("this.contract.getBitcoin() === null");
                return;
            }

            try{
                let txs = await this.contract.getBitcoin().getAddressTransactions(this.btc_address);
                let unspent = {};
                let spent = {};

                for(let i in txs){
                    let tx = txs[i];
                    for(let j in tx.vin){
                        delete unspent[tx.vin[j].txid + ":" + tx.vin[j].vout];
                        spent[tx.vin[j].txid + ":" + tx.vin[j].vout] = true;
                    }
                    for(let j in tx.vout){
                        let v = tx.vout[j];
                        if(v.scriptPubKey.addresses[0] === this.btc_address && !spent.hasOwnProperty(tx.txid + ":" + v.n)){
                            unspent[tx.txid + ":" + v.n] = {
                                value: v.value,
                                txid: tx.txid,
                                index: v.n,
                                tx: tx,
                            };
                            spent[tx.txid + ":" + v.n] = true;
                        }
                    }
                }
                resolve(unspent, txs);
            }catch (e) {
                console.log(e)
                resolve([]);
            }
        }))
    }

    async getBitcoinBalance(){
        return new Promise((async (resolve, reject) => {
            if(this.contract.getBitcoin() === null){
                throw new Error("this.contract.getBitcoin() === null");
            }

            this.getBitcoinUnspentTransactionsData(1000000).then((unspent, txs) => {
                let currentValue = 0;

                for(let i in unspent){
                    currentValue += unspent[i].value;
                }
                resolve(currentValue, txs);
            });
        }));

    }
}