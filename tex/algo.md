lets write a pseudo-code for recovery that updates the honest validator algorithm 1

execute Recovery(k, x):
  match x:
    case Recover(k', x'):
      execute Recovery(k', x')
    case _:
      if k is not finalised
        execute x
  set k finalised

Cert(k, x) := n - 3f (Vote, k, x)


on_transaction(tx, sigma): 
  signature, pending check remain the same
  require tx.nonce == account[tx.sender].nonce
  if tx.recipient is recovery_contract:
    validate_recovery(tx)
  else:
    validate_payment(tx)
   set pending 
   send <vote, tx.sender, tx.nonce, tx> to V

validate_recovery(tx, certificates):
    target_tx = tx.data.target_tx
    exist n - 3f target_tx certificate for height target_tx.nonce 
    exist n - 3f bot certificates for each heigh from target_tx.nonce + 1 to tx.nonce - 1

validate_payment(tx):
    require account[tx.sender].finalised == tx.nonce - 1 
    require account balance >= tx.amount
  
on_certificate(C):
    require C is valid >=n - f certificate for some nonce k 
    q, vote = max quorum in C

    if vote.nonce == account[vote.account].nonce:
        if q < n - 3f:
            // no quorum for k
            account[vote.account].pending = true
            broadcast <vote, vote.account, nonce, bot> to V
        else account[vote.account].pending:
            // update nonce and pending
            account[vote.account].nonce += 1
            account[vote.account].pending = false

    if q >= n - f:
        // safely move the nonce forward
        if vote.nonce >= account[vote.account].nonce: 
            account[vote.account].nonce = vote.nonce + 1
            account[vote.account].pending = false
        // execute the transaction
        if vote.nonce > account[vote.account].finalised and vote.tx is not bot:
            tx = get_tx_chain_start(vote.tx)
            if tx.nonce == account[vote.account].finalised + 1:
                update balances according to tx 
                account[vote.account].finalised = vote.nonce 

get_tx_chain_start(tx):
    if tx.recipient is recovery_contract:
        fetch_transaction(tx.data.target_tx)
    else:
        return tx 



3. Validator: Upon received (Tx, k, Recover(k', x')) 
        and exist Cert(l, bot) for all k' < l < k 
        and exist Cert(k', x') 
        and Recovery has enough payment on the chain // expensive to check
        and has not sent Vote for height k 
    // expontential timer based on k - k'
    Send (Vote, k, Recover(k', x')) 

4. Validator: Upon recieved (Tx, k, x)
        and x is not Recovery(_, _)
        and k - 1 is finalised 
        and has not sent Vote 
        and x is valid // check for balance and first round execution checks
    Send (Vote, k, x)

5. Validator: Upon receiving n-f (Vote, k, x) // Monitored even after exiting view k
        and x is not bot
    Execute x and its chain if its a recovery

6. Validator: Upon receiving n-f (Vote, k, *) 
       but no Cert(k, x) for any x 
    Send (Vote, k, bot) 

7. Upon receiving Cert(k, x) and has sent Vote
    Increment to k + 1


1. Client: 
    For highest k if k - 1 is finalised 
      Send (Tx, k, x) 
    Else 
      (k', x') = highest k' < k and exists Cert(k', x') and x' is not bot
      Send (Tx, k, Recover(k', x')) 

2. Fullnode: Upon receiving n - f (Vote, k, *) // triggered multiple times for the same k
    Forward these n-f (Vote, k, *) // optimise this by only forwarding if it triggers the ifs below
    If Cert(k, *) in n - f (Vote, k, *) 
      Increment to k + 1
    If n - f (Vote, k, x) in n - f (Vote, k, *) 
      Finalise x its chain
