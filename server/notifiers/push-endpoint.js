'use strict';
const {BlockList,isIP}=require('node:net');
const dns=require('node:dns'),https=require('node:https'),crypto=require('node:crypto');
const blocked=new BlockList();
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(address,prefix,'ipv4');
// Permit global-unicast IPv6 only, excluding documentation and transition ranges.
const globalV6=new BlockList();globalV6.addSubnet('2000::',3,'ipv6');
for(const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]])blocked.addSubnet(address,prefix,'ipv6');
function publicAddress(address){const family=isIP(address);return family===4?!blocked.check(address,'ipv4'):family===6&&globalV6.check(address,'ipv6')&&!blocked.check(address,'ipv6');}
function validEndpoint(endpoint){try{const url=new URL(endpoint),host=url.hostname.replace(/^\[|\]$/g,'');return typeof endpoint==='string'&&endpoint.length<=4096&&url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&(!url.port||url.port==='443')&&(isIP(host)?publicAddress(host):host.includes('.')&&!/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host));}catch{return false}}
function validKeys(keys){try{if(!keys||!['p256dh','auth'].every(k=>typeof keys[k]==='string'&&/^[A-Za-z0-9_-]+={0,2}$/.test(keys[k])))return false;const key=Buffer.from(keys.p256dh,'base64url'),auth=Buffer.from(keys.auth,'base64url');if(key.length!==65||key[0]!==4||auth.length!==16)return false;crypto.ECDH.convertKey(key,'prime256v1');return true;}catch{return false}}
function guardedLookup(host,options,callback){dns.lookup(host,{all:true},(error,addresses)=>{if(error)return callback(error);if(!addresses.length||addresses.some(row=>!publicAddress(row.address)))return callback(Object.assign(Error('Push endpoint must resolve to public addresses'),{code:'PUSH_ADDRESS_BLOCKED'}));if(options?.all)return callback(null,addresses);const chosen=addresses.find(row=>!options?.family||row.family===options.family);if(!chosen)return callback(Object.assign(Error('No matching address family'),{code:'ENOTFOUND'}));callback(null,chosen.address,chosen.family);});}
const pushAgent=new https.Agent({lookup:guardedLookup,keepAlive:false});
module.exports={validEndpoint,validKeys,publicAddress,guardedLookup,pushAgent};
