(module
 (type $0 (func (param f32) (result f32)))
 (export "gain" (func $gain))
 (func $gain (param $0 f32) (result f32)
  (f32.mul
   (local.get $0)
   (f32.const 0.5)
  )
 )
)
