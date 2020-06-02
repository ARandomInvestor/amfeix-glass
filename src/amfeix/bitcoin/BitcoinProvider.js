'use strict';

import async from "async"
import https from "https";
import zlib from "zlib";
import crypto from "crypto";
import http from "http"
import fs from "fs"
import path from "path"
import ElectrumClient from "electrum-client"
import bitcoin from "bitcoinjs-lib";

export default class BitcoinProvider{
    cache = {}
    constructor(client, index) {
        this.client = client;
        this.index = index;
        this.queue = async.queue(async (task, callback) => {
            let cache = this.getCache(task.key);
            if(cache !== null){
                task.resolve(cache);
                callback(null)
                return;
            }

            try{
                let data = await this.client.command(task.method, ...task.parameters);
                task.resolve(data);
            }catch (e) {
                console.log(e);
                task.resolve(null);
            }finally {
                if(callback){
                    callback();
                }
            }
        }, 8);
    }

    clearCache(){
        this.cache = {};
    }

    getCache(k){
        return (this.cache.hasOwnProperty(k) && this.cache[k][1] >= Date.now()) ? this.cache[k][0] : null;
    }

    setCache(k, v, age = 60){
        if(v === null){
            delete this.cache[k];
            return;
        }
        this.cache[k] = [v, Date.now() * age * 1000];
    }

    getFileCache(type, k){
        let cache = this.getCache(type + "." + k);
        if(cache === null){
            try{
                let result = fs.readFileSync(path.resolve("index", type, k[0], k + ".json"))
                cache = JSON.parse(result);
                if(cache !== null){
                    this.setCache(type + "." + k, cache, 3600);
                }
            }catch (e) {
                return null;
            }
        }

        return cache;
    }

    setFileCache(type, k, v){
        this.setCache(type + "." + k, v, 3600);
        fs.writeFile(path.resolve("index", type, k[0], k + ".json"), JSON.stringify(v, null, " "), () => {});
    }

    async getTransaction(txid){
        return new Promise((async (resolve, reject) => {
            if(txid.match(/^[0-9a-f]{64}$/i) === null){
                reject(new Error("Invalid transaction id " + txid))
                return;
            }
            let cache = this.getFileCache("tx", txid);
            if(cache !== null){
                resolve(cache);
                return;
            }

            this.queue.push({
                method: "getrawtransaction",
                parameters: [txid, 1],
                key: "tx." + txid,
                resolve: async (data) => {
                    if(data !== null){
                        if(data.confirmations > 0){
                            this.setFileCache("tx", txid, data);
                        }else{
                            this.setCache("tx." + txid, data);
                        }
                        resolve(data)
                    }
                    reject("Could not find transaction " + txid);
                },
                reject: reject
            }, (err) => {
            });
        }));
    }

    async getBestBlockInfo(){
        return new Promise(((resolve, reject) => {
            let cache = this.getCache("lastblock");
            if(cache !== null){
                resolve(cache);
                return;
            }

            this.queue.push({
                method: "getblockchaininfo",
                key: "lastblock",
                resolve: async (data) => {
                    if(data !== null){
                        this.setCache("lastblock", data);
                    }
                    resolve(data)
                },
                reject: reject
            }, (err) => {
            });
        }))
    }

    async getElectrumAddressHistory(address){
        return new Promise((async (resolve, reject) => {
            if(this.index === null){
                reject(new Error("this.index === null"));
            }

            let tryReceive = async () => {
                return new Promise(async (resolve, reject) => {
                    let electrum = new ElectrumClient(this.index.port, this.index.host, this.index.ssl ? 'ssl' : 'tcp');
                    await electrum.connect();

                    let sha256 = (data) => {
                        let hash = crypto.createHash('sha256');
                        hash.update(data);
                        return hash.digest();
                    };

                    let scripthash = sha256(bitcoin.payments.p2pkh({
                        address: address,
                    }).output).reverse().toString("hex");
                    try{
                        let history = await electrum.request("blockchain.scripthash.get_history", [scripthash]);
                        await electrum.close();
                        resolve(history);
                    }catch (e) {
                        await electrum.close();
                        reject(e)
                    }
                });
            }

            let history = null;

            for(let retry = 0; retry < 5; ++retry){
                try{
                    history = await tryReceive()
                    break;
                }catch (e) {
                    console.log(e)
                }
            }

            if(history === null){
                reject(new Error("maxed out retries for " + address))
            }

            resolve(history);
        }));

    }

    async getAddressTransactions(address, reverse = false) {
        return new Promise(async (resolve, reject) => {
            let cache = this.getCache("addresstx." + address + "." + (reverse ? 1 : 0));
            if (cache !== null) {
                resolve(cache);
                return;
            }
            let entries = null;
            try{
                entries = await this.getElectrumAddressHistory(address);
            }catch (e) {
                reject(e)
                return;
            }

            if (reverse) {
                entries = entries.reverse();
            }

            let newList = [];
            let mapping = {};

            if (entries !== null && entries.length > 0) {
                for (let i in entries) {
                    if (mapping.hasOwnProperty(entries[i].tx_hash)) {
                        continue;
                    }

                    let tx = await this.getTransaction(entries[i].tx_hash);
                    mapping[entries[i].tx_hash] = tx;
                    for (let j in tx.vin) {
                        let utxo = tx.vin[j];
                        let utxotx = await this.getTransaction(utxo.txid);
                        tx.vin[j].prevOut = {
                            addresses: utxotx.vout[utxo.vout].scriptPubKey.addresses,
                            value: utxotx.vout[utxo.vout].value
                        }
                    }
                    newList.push(tx);
                }

                this.setCache("addresstx." + address + "." + (reverse ? 1 : 0), newList);
                resolve(newList);
            } else {
                resolve([]);
            }
        });
    }
}