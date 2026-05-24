(module
 (type $0 (func (param f32) (result f32)))
 (memory $0 1 1)
 (export "memory" (memory $0))
 (export "applyGain" (func $applyGain))
 (func $applyGain (param $0 f32) (result f32)
  (f32.mul
   (local.get $0)
   (f32.load
    (i32.const 0)
   )
  )
 )
)
