'use strict';

import Web3 from "web3";
import fs from "fs";
import path from "path";


export default class StorageContract{
    cache = {};

    constructor(web3, btc = null, contractAddress = "0xb0963da9baef08711583252f5000Df44D4F56925") {
        this.web3 = web3;
        this.btc = btc;
        let ContractMeta = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "abi", contractAddress + ".json")));
        this.contract = new web3.eth.Contract(ContractMeta, contractAddress);
    }

    getProvider(){
        return this.web3;
    }

    getContract(){
        return this.contract;
    }

    getBitcoin(){
        return this.btc;
    }

    clearCache(){
        this.cache = {};
    }

    getCache(k){
        return (this.cache.hasOwnProperty(k) && this.cache[k][1] >= Date.now()) ? this.cache[k][0] : null;
    }

    setCache(k, v, age = 120){
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


    async getFundPerformance(){
        return new Promise((async (resolve, reject) => {
            let cache = this.getCache("getFundPerformance");
            if(cache !== null){
                resolve(cache);
                return;
            }

            let values = await this.contract.methods.getAll().call({});
            let index = [];

            for(let i in values.t){
                index.push({
                    time: values.t[i],
                    timestamp: new Date(values.t[i] * 1000),
                    value: values.a[i] / 100000000
                })
            }

            this.setCache("getFundPerformance", index, 900);
            resolve(index);
        }));
    }

    //??????
    async getFee1(){
        return new Promise((async (resolve, reject) => {
            let cache = this.getCache("getFee1");
            if(cache !== null){
                resolve(cache);
                return;
            }

            let value = await this.contract.methods.fee1().call({});
            this.setCache("getFee1", value, 900);

            resolve(value);
        }))
    }

    //Referrer fee
    async getFee2(){
        return new Promise((async (resolve, reject) => {
            let cache = this.getCache("getFee2");
            if(cache !== null){
                resolve(cache);
                return;
            }

            let value = await this.contract.methods.fee2().call({});
            this.setCache("getFee2", value, 900);

            resolve(value);
        }))
    }

    //Full?
    async getFee3(){
        return new Promise((async (resolve, reject) => {
            let cache = this.getCache("getFee3");
            if(cache !== null){
                resolve(cache);
                return;
            }

            let value = await this.contract.methods.fee3().call({});
            this.setCache("getFee3", value, 900);

            resolve(value);
        }))
    }


    async getAUM(){
        return new Promise((async (resolve, reject) => {
            let cache = this.getCache("getAUM");
            if(cache !== null){
                resolve(cache);
                return;
            }

            let value = await this.contract.methods.aum().call({});
            this.setCache("getAUM", value / 100000000);

            resolve(value / 100000000);
        }))
    }


    async getInvestors(){
        return new Promise((async (resolve, reject) => {
            let cache = this.getCache("getInvestors");
            if(cache !== null){
                resolve(cache);
                return;
            }

            let values = await this.contract.methods.getAllInvestors().call({});
            this.setCache("getInvestors", values);

            resolve(values);
        }))
    }

    async getAllValues(count, getter, ...args){
        return new Promise((async (resolve, reject) => {
            let c = await count(...args);
            let list = [];
            for(let n = 0; n < c; ++n){
                list.push(await getter(...args, ...[n]));
            }
            resolve(list);
        }));
    }



    async getDepositAddressCount(){
        return new Promise((async (resolve, reject) => {
            let cache = this.getCache("getDepositAddressCount");
            if(cache !== null){
                resolve(cache);
                return;
            }

            let v = await this.contract.methods.fundDepositAddressesLength().call({});
            this.setCache("getDepositAddressCount", parseInt(v));

            resolve(parseInt(v));
        }))
    }


    async getDepositAddress(n){
        return new Promise((async (resolve, reject) => {
            let cache = this.getFileCache("contract", "deposit_address_" + n);
            if(cache !== null){
                resolve(cache);
                return;
            }

            let v = await this.contract.methods.fundDepositAddresses(n).call({});
            this.setFileCache("contract", "deposit_address_" + n, v);

            resolve(v);
        }))
    }

    async getDepositAddresses(){
        return this.getAllValues(this.getDepositAddressCount.bind(this), this.getDepositAddress.bind(this));
    }


    async getFeeAddressCount(){
        return new Promise((async (resolve, reject) => {
            let cache = this.getCache("getFeeAddressCount");
            if(cache !== null){
                resolve(cache);
                return;
            }

            let v = await this.contract.methods.feeAddressesLength().call({});
            this.setCache("getFeeAddressCount", parseInt(v));

            resolve(parseInt(v));
        }));
    }


    async getFeeAddress(n){
        return new Promise((async (resolve, reject) => {
            let cache = this.getFileCache("contract", "fee_address_" + n);
            if(cache !== null){
                resolve(cache);
                return;
            }

            let v = await this.contract.methods.feeAddresses(n).call({});
            this.setFileCache("contract", "fee_address_" + n, v);

            resolve(v);
        }));
    }

    async getFeeAddresses(){
        return this.getAllValues(this.getFeeAddressCount.bind(this), this.getFeeAddress.bind(this));
    }



    async getTxCount(address){
        return new Promise((async (resolve, reject) => {
            let v = await this.contract.methods.ntx(address).call({});
            resolve(parseInt(v));
        }))
    }


    async getTx(address, n){
        return new Promise((async (resolve, reject) => {
            let cache = this.getFileCache("contract_tx", address.slice(2).toLowerCase() + "_" + n);
            if(cache !== null){
                resolve(cache);
                return;
            }

            let v = await this.contract.methods.getTx(address, n).call({});
            let data = {
                txid: v[0],
                pubkey: v[1],
                signature: v[2],
                action: parseInt(v[3]),
                time: v[4],
                timestamp: new Date(v[4] * 1000)
            };

            this.setFileCache("contract_tx", address.slice(2).toLowerCase() + "_" + n, data);

            resolve(data);
        }))
    }

    async getTxs(address){
        return this.getAllValues(this.getTxCount.bind(this), this.getTx.bind(this), address);
    }

    async getWithdrawRequestCount(address){
        return new Promise((async (resolve, reject) => {
            resolve(parseInt(await this.contract.methods.rtx(address).call({})));
        }));
    }


    async getWithdrawRequest(address, n){
        return new Promise((async (resolve, reject) => {
            let cache = this.getFileCache("contract_rtx", address.slice(2).toLowerCase() + "_" + n);
            if(cache !== null){

                resolve(cache);
                return;
            }

            let v = await this.contract.methods.reqWD(address, n).call({});
            let data = {
                txid: v.txId,
                pubkey: v.pubKey,
                signature: v.signature,
                action: parseInt(v.action),
                time: v.timestamp,
                timestamp: new Date(v.timestamp * 1000),
                referal: v.referal
            };

            this.setFileCache("contract_rtx", address.slice(2).toLowerCase() + "_" + n, data);

            resolve(data);
        }));
    }

    async getWithdrawRequests(address){
       return this.getAllValues(this.getWithdrawRequestCount.bind(this), this.getWithdrawRequest.bind(this), address);
    }

}