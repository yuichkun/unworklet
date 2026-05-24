(module
 (type $0 (func))
 (memory $0 1 1)
 (export "memory" (memory $0))
 (export "process" (func $process))
 (func $process
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
    (f32.store
     (i32.add
      (i32.mul
       (local.get $0)
       (i32.const 4)
      )
      (i32.const 512)
     )
     (f32.mul
      (f32.load
       (i32.mul
        (local.get $0)
        (i32.const 4)
       )
      )
      (f32.const 0.5)
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
 )
)
