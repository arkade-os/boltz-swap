import { script, networks, Network as BtcJsNetwork } from '@scure/btc-signer';
import { Network } from '../types';

export function getBitcoinNetwork(network: Network): BtcJsNetwork {
  if (network === 'mainnet') return networks.bitcoin;
  if (network === 'testnet') return networks.testnet;
  if (network === 'regtest') return networks.regtest;
  throw new Error(`Unknown network: ${network}`);
}

export function createHtlcScript(
  recipientPubkey: Uint8Array,
  refundPubkey: Uint8Array,
  hashlock: Uint8Array,
  timelock: number
): Uint8Array {
  return script.compile([
    'OP_HASH160',
    hashlock,
    'OP_EQUAL',
    'OP_IF',
    recipientPubkey,
    'OP_ELSE',
    script.number.encode(timelock),
    'OP_CHECKSEQUENCEVERIFY',
    'OP_DROP',
    refundPubkey,
    'OP_ENDIF',
    'OP_CHECKSIG',
  ]);
}