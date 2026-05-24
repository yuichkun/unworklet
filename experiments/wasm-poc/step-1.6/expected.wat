(module
 (type $0 (func))
 (memory $0 1 1)
 (export "memory" (memory $0))
 (export "countTo128" (func $countTo128))
 (func $countTo128
  (local $0 i32)
  (local.set $0
   (i32.const 0)
  )
  (block $break
   (loop $continue
    (br_if $break
     (i32.ge_s
      (local.get $0)
      (i32.const 128)
     )
    )
    (local.set $0
     (i32.add
      (local.get $0)
      (i32.const 1)
     )
    )
    (br $continue)
   )
  )
  (i32.store
   (i32.const 0)
   (local.get $0)
  )
 )
)
