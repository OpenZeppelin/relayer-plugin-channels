#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct SmokeContract;

#[contractimpl]
impl SmokeContract {
    // No auth; simple bump-like op that returns n+1
    pub fn no_auth_bump(_env: Env, n: u32) -> u32 {
        n.saturating_add(1)
    }

    // Requires address auth; writes value under address key
    pub fn write_with_address_auth(env: Env, addr: Address, value: u32) {
        addr.require_auth();
        let store = env.storage().instance();
        store.set(&addr, &value);
    }

    // Reads value for address; returns 0 if missing
    pub fn read_value(env: Env, addr: Address) -> u32 {
        let store = env.storage().instance();
        store.get(&addr).unwrap_or(0u32)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address};

    #[test]
    fn roundtrip() {
        let env = Env::default();
        let id = env.register_contract(None, SmokeContract);
        let client = SmokeContractClient::new(&env, &id);

        let user = Address::generate(&env);

        assert_eq!(client.no_auth_bump(&1), 2);

        // read before write returns default 0
        assert_eq!(client.read_value(&user), 0);

        // write with address auth
        user.require_auth_for_args(&env, (&user, 7u32).into_val(&env));
        client.write_with_address_auth(&user, &7);
        assert_eq!(client.read_value(&user), 7);
    }
}

